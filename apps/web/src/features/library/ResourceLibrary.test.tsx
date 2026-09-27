// @vitest-environment jsdom
/**
 * The resource library's tests.  (P2-T9)
 *
 * ## The test that matters
 *
 * `shows the blast radius on the row, not in a dialog`. Everything else in this file is
 * mechanics. This one asserts the property the packet is actually about — that a teacher can
 * see what they are about to break BEFORE they express the intent — and it is a DOM query
 * rather than a snapshot, because a snapshot would happily pass on a library that showed the
 * numbers in a modal and the assertion would be reading the wrong node.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LibraryActions, type LibraryRow, ResourceLibrary } from './ResourceLibrary.js';

afterEach(cleanup);

const row = (o: Partial<LibraryRow> = {}): LibraryRow => ({
  id: 'r1',
  title: 'Tidal locking',
  kind: 'LESSON',
  status: 'PUBLISHED',
  visibility: 'UNLISTED',
  classroomCount: 3,
  attemptsInFlight: 0,
  updatedLabel: '2026-09-20',
  blockedReason: null,
  ...o,
});

const noopActions = (): LibraryActions => ({
  transfer: async () => ({ ok: false, reason: 'not wired' }),
  duplicate: async () => ({ ok: false, reason: 'not wired' }),
});

describe('ResourceLibrary', () => {
  it('shows the blast radius on the row, not in a dialog', () => {
    render(
      <ResourceLibrary
        rows={[row({ classroomCount: 3, attemptsInFlight: 0 })]}
        actions={noopActions()}
      />,
    );
    // Present in the initial DOM, with no interaction. A dialog is not a disclosure of
    // consequences; it is a hurdle after the decision.
    expect(screen.getByText('3 classrooms')).toBeTruthy();
    expect(screen.getByText('Attempts in progress')).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the blast radius as a definition list', () => {
    const { container } = render(<ResourceLibrary rows={[row()]} actions={noopActions()} />);
    // Announced as "3 classrooms, 3" rather than as a run of numbers in a row of divs.
    expect(container.querySelector('dl.blast')).not.toBeNull();
    expect(container.querySelectorAll('dt').length).toBeGreaterThanOrEqual(2);
  });

  it('disables Transfer and states the reason as real text when an attempt is live', () => {
    render(
      <ResourceLibrary
        rows={[row({ attemptsInFlight: 1, blockedReason: '1 attempt is in progress right now' })]}
        actions={noopActions()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Not a `title` attribute: a disabled button's title is announced as "dimmed" on some
    // readers and skipped on others, and the reason is the entire content of the message.
    const reason = screen.getByText(/1 attempt is in progress right now/);
    expect(reason.textContent).toContain('Cannot transfer yet');
    expect(reason.getAttribute('title')).toBeNull();
  });

  it('describes the blocked button rather than renaming it', () => {
    render(
      <ResourceLibrary
        rows={[row({ attemptsInFlight: 2, blockedReason: '2 attempts are in progress right now' })]}
        actions={noopActions()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Transfer' });
    // A label REPLACES the visible text; a description supplements it. Overwriting "Transfer"
    // with the reason means a screen reader never hears the word "Transfer" as the name.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('2 attempts');
    expect(button.getAttribute('aria-label')).toBeNull();
  });

  it('keeps Duplicate available even when a transfer is blocked', () => {
    // A live attempt must not freeze the resource. Publishing a corrected version is the move
    // that preserves the version chain, and blocking it would push a teacher towards deleting
    // something they still need.
    render(
      <ResourceLibrary
        rows={[row({ attemptsInFlight: 1, blockedReason: 'live' })]}
        actions={noopActions()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('announces the row count so a filter changing the list is not silent', () => {
    render(<ResourceLibrary rows={[row(), row({ id: 'r2' })]} actions={noopActions()} />);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('2 resources');
  });

  it('says nothing is here when the library is empty, rather than rendering an empty list', () => {
    const { container } = render(<ResourceLibrary rows={[]} actions={noopActions()} />);
    expect(screen.getByText('You have not written anything yet.')).toBeTruthy();
    // An empty `<ul>` announces as a list with no items, which reads as a failed load.
    expect(container.querySelector('ul.library')).toBeNull();
  });

  it('requires a reason before the transfer will submit, and explains why', async () => {
    // Typed to `LibraryActions['transfer']` rather than left to inference: an untyped mock
    // returning `{ ok: true }` widens `ok` to `boolean`, which is not assignable to the
    // discriminated union the component actually switches on -- and a mock whose type does
    // not match the interface is a mock that never tested the interface.
    const transfer: LibraryActions['transfer'] = vi.fn(
      async (): Promise<{ ok: true }> => ({ ok: true }),
    );
    render(<ResourceLibrary rows={[row()]} actions={{ ...noopActions(), transfer }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    const submit = screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('New owner (user id)'), { target: { value: 'u9' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'short' } });
    expect((screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/needs a reason/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Why'), {
      target: { value: 'Dan is covering the class while I am on leave' },
    });
    expect((screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports an UNKNOWN outcome as unknown rather than as a failure', async () => {
    // A thrown action might have applied. Telling a teacher it failed invites a retry, and a
    // retry of a destructive action is how you get two of them.
    const transfer: LibraryActions['transfer'] = vi.fn(
      async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
        throw new Error('socket hang up');
      },
    );
    render(<ResourceLibrary rows={[row()]} actions={{ ...noopActions(), transfer }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    fireEvent.change(screen.getByLabelText('New owner (user id)'), { target: { value: 'u9' } });
    fireEvent.change(screen.getByLabelText('Why'), {
      target: { value: 'Dan is covering the class while I am on leave' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('do not know whether it worked');
    });
  });

  it('shows a refusal as an alert, and a success as a status', async () => {
    const { unmount } = render(
      <ResourceLibrary
        rows={[row()]}
        actions={{
          ...noopActions(),
          duplicate: async () => ({ ok: false, reason: '1 attempt is in progress right now' }),
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('1 attempt is in progress');
    });
    unmount();

    render(
      <ResourceLibrary
        rows={[row()]}
        actions={{ ...noopActions(), duplicate: async () => ({ ok: true, resourceId: 'r9' }) }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => {
      // `status` for a confirmation: it is not an error and should not be announced as one.
      expect(screen.getByRole('status').textContent).toContain('Duplicated');
    });
  });

  it('leaves the row list a real list, so position is announced', () => {
    const { container } = render(
      <ResourceLibrary
        rows={[row(), row({ id: 'r2', title: 'Phases of the moon' })]}
        actions={noopActions()}
      />,
    );
    expect(container.querySelectorAll('ul.library > li').length).toBe(2);
  });
});
