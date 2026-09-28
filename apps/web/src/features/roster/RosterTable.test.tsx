// @vitest-environment jsdom
/**
 * The roster's tests.  (P4-T6)
 *
 * ## The test that matters
 *
 * `names every person a bulk removal will affect, before it will happen`. `plans/12` §5 says
 * "confirmation dialogs that name the person. A mis-click that removes 30 students is a support
 * incident and a trust breach", and the codebase policy is that there are no dialogs at all — so
 * the requirement has to be satisfied by an inline disclosure, and the test has to check the
 * substance rather than the shape. A test that asserted `role="dialog"` would be testing the
 * thing the codebase deliberately does not do.
 *
 * It is a DOM query over the INITIAL interaction state and not a snapshot, because a snapshot
 * would happily pass on a roster that names nobody, and the assertion would be reading the wrong
 * node.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RosterActions, RosterTable, type RosterUiRow } from './RosterTable.js';

// `toHaveNoViolations` is not a vitest matcher; the type file declares it and this extends it.
expect.extend(toHaveNoViolations);

afterEach(cleanup);

const row = (o: Partial<RosterUiRow> = {}): RosterUiRow => ({
  enrollmentId: 'e1',
  userId: 'u1',
  displayName: 'Amara Okafor',
  accountName: 'Amara Okafor',
  hasDisplayNameOverride: false,
  email: 'amara@school.example',
  role: 'STUDENT',
  status: 'ACTIVE',
  joinedAtLabel: '01 Sep 2026',
  isPlaceholder: false,
  summary: {
    assignmentsPublished: 4,
    attempts: 3,
    completed: 2,
    inProgress: 1,
    releasedGrades: 1,
    latestReleasedLabel: '82.0%',
    accommodations: 0,
    lastActivityLabel: '20 Sep 2026',
  },
  ...o,
});

const manyRows = (n: number): RosterUiRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({ enrollmentId: `e${i}`, userId: `u${i}`, displayName: `Student ${i}` }),
  );

const okActions = (over: Partial<RosterActions> = {}): RosterActions => ({
  changeRole: async () => ({ ok: true }),
  remove: async () => ({ ok: true, removed: 1 }),
  restore: async () => ({ ok: true, restored: 1 }),
  setSearch: async () => undefined,
  setRoleFilter: async () => undefined,
  clearSearch: async () => undefined,
  showEnded: async () => undefined,
  ...over,
});

const base = (o: Partial<Parameters<typeof RosterTable>[0]> = {}) => ({
  rows: [row()],
  total: 1,
  hasMore: false,
  nextCursor: null,
  empty: null,
  endedCount: null,
  search: '',
  roleFilter: null,
  showEnded: false,
  actions: okActions(),
  ...o,
});

describe('RosterTable', () => {
  it('has no axe violations, with and without a selection', async () => {
    const { container } = render(<RosterTable {...base({ rows: manyRows(3) })} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByLabelText('Select everyone on this page'));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names every person a bulk removal will affect, BEFORE it will happen', async () => {
    const remove = vi.fn(async () => ({ ok: true as const, removed: 3 }));
    render(
      <RosterTable
        {...base({
          rows: ['Amara Okafor', 'Bo Chen', 'Cy Adeyemi'].map((n, i) =>
            row({ enrollmentId: `e${i}`, userId: `u${i}`, displayName: n }),
          ),
          total: 3,
          actions: okActions({ remove }),
        })}
      />,
    );

    // The count is on the button, with no interaction at all.
    fireEvent.click(screen.getByLabelText('Select everyone on this page'));
    expect(screen.getByRole('button', { name: 'Remove 3' })).toBeTruthy();

    // Pressing it reveals a disclosure that NAMES them, and does not remove anything yet.
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3' }));
    const group = screen.getByRole('group', { name: 'Confirm removal' });
    expect(within(group).getByText('Amara Okafor')).toBeTruthy();
    expect(within(group).getByText('Bo Chen')).toBeTruthy();
    expect(within(group).getByText('Cy Adeyemi')).toBeTruthy();
    expect(remove, 'nothing may be removed before the confirmation').not.toHaveBeenCalled();

    // And the plan's own reason for the confirmation is on screen: what is NOT undone.
    expect(group.textContent).toMatch(/keeps everything they did/);
  });

  it('requires the COUNT to be typed for a bulk removal, but not for one person', async () => {
    const remove = vi.fn(async () => ({ ok: true as const, removed: 2 }));
    render(
      <RosterTable {...base({ rows: manyRows(2), total: 2, actions: okActions({ remove }) })} />,
    );
    fireEvent.click(screen.getByLabelText('Select everyone on this page'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));

    const group = screen.getByRole('group', { name: 'Confirm removal' });
    const confirm = within(group).getByRole('button', { name: 'Remove 2' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(group).getByLabelText('Type 2 to confirm'), {
      target: { value: '2' },
    });
    expect(confirm).toBeEnabled();
    // The wrong number does not work either.
    fireEvent.change(within(group).getByLabelText('Type 2 to confirm'), {
      target: { value: '3' },
    });
    expect(confirm).toBeDisabled();

    // A single person needs no typing: there is no way to mis-aim a one-person action by
    // dragging, so making a teacher type "1" would be ceremony rather than a safeguard.
    cleanup();
    render(<RosterTable {...base({ actions: okActions({ remove }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amara Okafor' }));
    expect(screen.queryByLabelText(/^Type \d/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove 1' })).toBeEnabled();
  });

  it('never opens a dialog, because a dialog is a hurdle after the decision', () => {
    render(<RosterTable {...base({ rows: manyRows(2), total: 2 })} />);
    fireEvent.click(screen.getByLabelText('Select everyone on this page'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('names the person in a single removal, not a count', () => {
    render(<RosterTable {...base()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amara Okafor' }));
    expect(screen.getByText('Remove Amara Okafor from the class?')).toBeTruthy();
  });

  it('says a display name override is an override, in words', () => {
    // §6 requires it "shown distinctly", and a purely visual difference is invisible to a screen
    // reader and to a teacher who has never seen the account name.
    render(
      <RosterTable
        {...base({
          rows: [
            row({
              displayName: 'Reddy K',
              accountName: 'Legalname X',
              hasDisplayNameOverride: true,
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText(/shown as “Reddy K”, account name “Legalname X”/)).toBeTruthy();
  });

  it('says a placeholder is a placeholder, and not an account they have used', () => {
    render(<RosterTable {...base({ rows: [row({ isPlaceholder: true })] })} />);
    expect(screen.getByText(/awaiting registration/)).toBeTruthy();
  });

  it('offers no Remove for an OWNER, and says why', () => {
    // Ownership is left by TRANSFERRING. An always-refusing Remove button teaches the teacher the
    // page is broken.
    render(<RosterTable {...base({ rows: [row({ role: 'OWNER', displayName: 'Ms Vale' })] })} />);
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(screen.getByText('transfer ownership to leave')).toBeTruthy();
  });

  it('says "none released yet" rather than a zero, because zero is a mark that was awarded', () => {
    render(
      <RosterTable
        {...base({
          rows: [
            row({ summary: { ...row().summary, releasedGrades: 0, latestReleasedLabel: null } }),
          ],
        })}
      />,
    );
    expect(screen.getByText('none released yet')).toBeTruthy();
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('reports an UNKNOWN outcome as unknown, not as a failure inviting a retry', async () => {
    const remove = vi.fn(async () => {
      throw new Error('network');
    });
    render(<RosterTable {...base({ actions: okActions({ remove }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amara Okafor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));

    await waitFor(() => {
      expect(screen.getByTestId('roster-status').textContent).toMatch(
        /do not know whether it worked/,
      );
    });
    // And no Undo appears, because nothing is known to have been removed.
    expect(screen.queryByTestId('roster-undo')).toBeNull();
  });

  it('offers an undo after a removal, and clears it once used', async () => {
    const restore = vi.fn(async () => ({ ok: true as const, restored: 1 }));
    render(<RosterTable {...base({ actions: okActions({ restore }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amara Okafor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));

    const undo = await screen.findByRole('button', { name: 'Undo the last removal' });
    fireEvent.click(undo);
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ enrollmentIds: ['e1'] }));
    await waitFor(() => expect(screen.queryByTestId('roster-undo')).toBeNull());
  });

  it('gives every empty state its own words and a way out, and none of them says "no results"', () => {
    const { unmount } = render(
      <RosterTable
        {...base({
          rows: [],
          total: 0,
          empty: { reason: 'noMembers', inScope: 0 },
        })}
      />,
    );
    expect(screen.getByTestId('roster-empty').textContent).toMatch(/Invite people to begin/);
    unmount();

    render(
      <RosterTable
        {...base({
          rows: [],
          total: 40,
          search: 'Zzz',
          empty: { reason: 'searchExcluded', inScope: 40, search: 'Zzz' },
        })}
      />,
    );
    // The honest fix is named, because "no results" sends a teacher to a support ticket.
    expect(screen.getByTestId('roster-empty').textContent).toMatch(/none matching/);
    expect(screen.getByTestId('roster-empty').textContent).toMatch(/Clear the search/);
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  it('offers to reveal students who left, with a count, rather than an empty page', async () => {
    const showEnded = vi.fn(async () => undefined);
    render(
      <RosterTable
        {...base({ rows: [], total: 0, endedCount: 2, actions: okActions({ showEnded }) })}
      />,
    );
    expect(screen.getByTestId('roster-ended-note').textContent).toMatch(
      /2 students no longer in this class/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(showEnded).toHaveBeenCalled());
  });

  it('truncates a long list of names and says how many were not shown', () => {
    // 30 names is the case §5 is about. Printing all 30 is its own failure: a disclosure too long
    // to read is a disclosure nobody reads, which is the problem the confirmation existed to fix.
    render(<RosterTable {...base({ rows: manyRows(30), total: 30 })} />);
    fireEvent.click(screen.getByLabelText('Select everyone on this page'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 30' }));
    const group = screen.getByRole('group', { name: 'Confirm removal' });
    expect(within(group).getByText('and 18 more')).toBeTruthy();
  });

  it('announces progress as a definition list, with position in set', async () => {
    render(<RosterTable {...base()} />);
    const progress = screen.getByLabelText('Progress for Amara Okafor');
    expect(progress.tagName).toBe('DL');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('a search is submitted, and clearing it is a separate affordance', async () => {
    const setSearch = vi.fn(async () => undefined);
    const clearSearch = vi.fn(async () => undefined);
    render(
      <RosterTable
        {...base({
          search: 'ada',
          actions: okActions({ setSearch, clearSearch }),
        })}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(clearSearch).toHaveBeenCalled());
    expect(setSearch).not.toHaveBeenCalled();
  });
});
