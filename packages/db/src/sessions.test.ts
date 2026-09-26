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
import { describeDevice, type SessionRow, toSessionState } from './sessions.js';

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
    const revokedAt = new Date('2026-09-26T12:30:00.000Z');
    const s = toSessionState(row({ revokedAt, revokedReason: 'passwordChanged' }));
    // The expected value is built from the SAME Date object rather than re-deriving it from a
    // second `row(...)` call with a `!` on a nullable field. Asserting against the input is
    // clearer and needs no assertion that the linter has to be told to ignore.
    expect(s.revokedAt).toBe(revokedAt.getTime());
    expect(s.revokedReason).toBe('passwordChanged');
  });
});

// The device LABEL lives in an integration test, but the one thing that is pure and easy to
// get wrong belongs here: an unrecognised user agent must not be guessed at. Guessing wrong is
// worse than not knowing, because a student told "Chrome on Windows" while holding a Chromebook
// will revoke the wrong session — and on a security page, a wrong label costs trust in the
// whole page.
describe('describeDevice never guesses', () => {
  it('admits when it does not recognise the agent', () => {
    expect(describeDevice('SomeCustomAgent/1.0')).toBe('Unknown device');
  });
});
