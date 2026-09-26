/**
 * The sessions page.  (P1-T4)
 *
 * Two properties, and the second is the one that is easy to get wrong:
 *
 *   1. The accessible name of each revoke button names its TARGET, so a screen-reader user on
 *      a list of five devices knows which one they are about to sign out.
 *   2. A failed revoke does NOT remove the row. The epoch bump and the row removal are two
 *      different facts, and a UI that removes the row and then fails the request has told the
 *      user something false. On a security page, false is what costs trust — a user who sees
 *      their other laptop disappear and then refreshes to find it still signed in will not
 *      believe the page next time either.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { type DeviceSession, SessionList } from './SessionList';

expect.extend(toHaveNoViolations);

const devices: DeviceSession[] = [
  { id: 's-1', device: 'Chrome on Windows', lastSeenLabel: 'today, 09:14', current: true },
  { id: 's-2', device: 'Safari on iOS', lastSeenLabel: 'yesterday, 21:03', current: false },
  { id: 's-3', device: 'Firefox on Linux', lastSeenLabel: '3 days ago', current: false },
];

const ok = { revoke: async () => ({ ok: true }) };

describe('accessibility', () => {
  it('has no detectable WCAG violations', async () => {
    const { container } = render(<SessionList sessions={devices} actions={ok} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is a real list, so position-in-set is announced', () => {
    render(<SessionList sessions={devices} actions={ok} />);
    // Not a div grid pretending. A device list is a list.
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('names the target of each revoke button in its accessible name', () => {
    render(<SessionList sessions={devices} actions={ok} />);
    // Five rows all reading "Sign out" tell a screen-reader user nothing about which one they
    // are on, which on a security page means revoking the wrong device.
    expect(screen.getByRole('button', { name: 'Sign out Safari on iOS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out Firefox on Linux' })).toBeInTheDocument();
    // Visible text stays short.
    expect(screen.getAllByText('Sign out')).toHaveLength(2);
  });

  it('offers no revoke button for the device you are using', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => ({ ok: true }));
    render(<SessionList sessions={devices} actions={{ revoke }} />);
    expect(screen.getByText('(this device)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Chrome on Windows/ })).not.toBeInTheDocument();
    // And clicking around cannot reach it.
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(revoke).toHaveBeenCalledWith('s-2');
  });
});

describe('revoking a row', () => {
  it('removes it only after the server confirms', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    render(<SessionList sessions={devices} actions={{ revoke }} />);

    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    // While the request is in flight the row is STILL THERE. Removing it early would tell the
    // user something that has not happened yet.
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();

    release();
    await waitFor(() => expect(screen.queryByText('Safari on iOS')).not.toBeInTheDocument());
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the row AND explains when the server refuses', async () => {
    // The false-reporting case. Removing the row on a failed request is the specific bug this
    // test exists to prevent.
    const user = userEvent.setup();
    render(<SessionList sessions={devices} actions={{ revoke: async () => ({ ok: false }) }} />);
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));

    await waitFor(() =>
      expect(screen.getByTestId('sessions-status')).toHaveTextContent(/did not work/),
    );
    expect(
      screen.getByText('Safari on iOS'),
      'a failed revoke must not remove the row',
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('clears a previous error when the next attempt is made', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    render(
      <SessionList
        sessions={devices}
        actions={{
          revoke: async () => {
            attempts += 1;
            return { ok: attempts > 1 };
          },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    await waitFor(() =>
      expect(screen.getByTestId('sessions-status')).toHaveTextContent(/did not work/),
    );

    await user.click(screen.getByRole('button', { name: 'Sign out Firefox on Linux' }));
    await waitFor(() => expect(screen.queryByText('Firefox on Linux')).not.toBeInTheDocument());
    expect(screen.getByTestId('sessions-status')).not.toHaveTextContent(/did not work/);
  });

  it('marks the button busy while the request is in flight', async () => {
    const user = userEvent.setup();
    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    render(
      <SessionList
        sessions={devices}
        actions={{
          revoke: async () => {
            await gate;
            return { ok: true };
          },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign out Safari on iOS' })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    );
  });
});

describe('the empty case', () => {
  it('says so plainly rather than showing an empty list', () => {
    render(<SessionList sessions={[]} actions={ok} />);
    expect(screen.getByTestId('sessions-empty')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('and is still accessible', async () => {
    const { container } = render(<SessionList sessions={[]} actions={ok} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('after signing out every other device', () => {
  it('the current device REMAINS, because it is not revocable', async () => {
    // The first draft of this test asserted the list collapses to the empty message. That is
    // unreachable: the current device has no revoke button by design, so `visible` can never be
    // empty while you are signed in here. The empty state is reachable only when the server
    // genuinely returns no sessions, which is a separate test above.
    //
    // Asserting the real behaviour is the useful version — it pins that signing out elsewhere
    // does not sign YOU out, which is the promise the page's own copy makes.
    const user = userEvent.setup();
    render(<SessionList sessions={devices} actions={ok} />);
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign out Firefox on Linux' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Sign out Firefox on Linux' }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByText('Chrome on Windows')).toBeInTheDocument();
    expect(screen.getByText('(this device)')).toBeInTheDocument();
    expect(screen.queryByTestId('sessions-empty')).not.toBeInTheDocument();
  });
});
