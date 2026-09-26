'use client';

/**
 * The sessions page: every device signed in, with a revoke button per row.  (P1-T4)
 *
 * ## Why this page exists at all
 *
 * Because "sign out everywhere" is not a thing a user can do from a menu they have to go
 * hunting for, and because the alternative — a compromised account that the owner cannot see
 * or clear — is the exact scenario INV-AUTH-1 exists for. A student who suspects someone else
 * has their account needs to SEE the other sessions to know which one to revoke.
 *
 * ## The three accessibility decisions that matter here
 *
 *   · **The list is a real `<ul>`.** Not a table of divs, and not a grid pretending. A device
 *     list is a list, and screen readers announce position-in-set.
 *   · **The revoke button names its target.** "Revoke" on five rows tells a screen-reader user
 *     nothing about which row they are on, so the accessible name is "Sign out Chrome on
 *     Windows". The visible text stays short.
 *   · **Revoking the CURRENT device is not offered as a link.** It is a destructive action on
 *     the thing the user is holding, so it says what it does. A "sign out" link that looks
 *     like navigation is how people accidentally end up logged out.
 *
 * ## The optimistic-update trap
 *
 * Revoking a row does NOT remove it from the list immediately. The epoch bump and the row
 * removal are two different facts, and a UI that removes the row and then fails the request
 * has told the user something false — and on a security page, false is the thing that costs
 * trust. The row disappears only when the server confirms.
 */

import { useState } from 'react';

export interface DeviceSession {
  readonly id: string;
  /** Coarse label only. The raw user agent never reaches the browser. */
  readonly device: string;
  /** Pre-formatted by the server, in the viewer's locale and zone. */
  readonly lastSeenLabel: string;
  readonly current: boolean;
}

export interface SessionActions {
  revoke(sessionId: string): Promise<{ ok: boolean }>;
}

export function SessionList(props: {
  sessions: readonly DeviceSession[];
  actions: SessionActions;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const onRevoke = async (sessionId: string) => {
    setPending(sessionId);
    setError(null);
    try {
      const result = await props.actions.revoke(sessionId);
      if (result.ok) {
        setRemoved((prev) => new Set([...prev, sessionId]));
      } else {
        setError('That did not work. Try again in a moment.');
      }
    } finally {
      setPending(null);
    }
  };

  const visible = props.sessions.filter((s) => !removed.has(s.id));

  return (
    <section aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Where you are signed in</h2>
      <p>
        If you do not recognise a device, sign it out. Signing out of another device does not affect
        this one.
      </p>

      {/* One live region for the whole list, rather than one per row. */}
      <div role="status" aria-live="polite" data-testid="sessions-status">
        {error ?? ''}
      </div>

      {visible.length === 0 ? (
        <p data-testid="sessions-empty">You are not signed in anywhere else.</p>
      ) : (
        <ul data-testid="session-list">
          {visible.map((s) => (
            <li key={s.id}>
              <span>{s.device}</span>{' '}
              {s.current ? (
                <strong>(this device)</strong>
              ) : (
                <span>Last seen {s.lastSeenLabel}</span>
              )}
              {s.current ? null : (
                <button
                  type="button"
                  onClick={() => onRevoke(s.id)}
                  // The accessible NAME names the target; the visible text stays short. Five
                  // rows all reading "Sign out" tell a screen-reader user nothing about which
                  // one they are on.
                  aria-label={`Sign out ${s.device}`}
                  aria-busy={pending === s.id}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
