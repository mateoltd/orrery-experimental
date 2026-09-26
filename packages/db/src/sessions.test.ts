/**
 * The row -> policy mapping.  (P1-T4)
 *
 * Small and pure, and pinned here because this is the seam where a mismatch is invisible.
 *
 * `SessionState.issuedAt` is the anchor for the ABSOLUTE expiry cap, and the column is called
 * `createdAt`. They are the same instant, and the mapping happens in exactly one function. A
 * future rename of either side has to come through here, which is why this test exists: the
 * integration suite caught the real mismatch, but only after a migration, a generated client
 * and a running database. This one runs in 2ms.
 */

import { describe, expect, it } from 'vitest';
import { type SessionRow, toSessionState } from './sessions.js';

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 's-1',
  userId: 'u-1',
  tokenHash: 'h'.repeat(43),
  familyId: 'f-1',
  createdAt: new Date('2026-09-26T12:00:00.000Z'),
  expiresAt: new Date('2026-09-26T14:00:00.000Z'),
  revokedAt: null,
  revokedReason: null,
  ...over,
});

describe('toSessionState', () => {
  it('maps createdAt to issuedAt, which is what the absolute cap anchors to', () => {
    const s = toSessionState(row());
    expect(s.issuedAt).toBe(row().createdAt.getTime());
    expect(s.sessionId).toBe('s-1');
    expect(s.familyId).toBe('f-1');
  });

  it('maps a null revocation to a null revocation, not to epoch zero', () => {
    // `new Date(0)` is 1970. A `??` that turned null into 0 would make every live session
    // look revoked since the beginning of time, which is the kind of bug that only shows up
    // as "everyone is logged out".
    const s = toSessionState(row());
    expect(s.revokedAt).toBeNull();
    expect(s.revokedReason).toBeNull();
  });

  it('carries a real revocation through with its reason', () => {
    const s = toSessionState(
      row({
        revokedAt: new Date('2026-09-26T12:30:00.000Z'),
        revokedReason: 'passwordChanged',
      }),
    );
    expect(s.revokedAt).toBe(
      row({ revokedAt: new Date('2026-09-26T12:30:00.000Z') }).revokedAt!.getTime(),
    );
    expect(s.revokedReason).toBe('passwordChanged');
  });
});
