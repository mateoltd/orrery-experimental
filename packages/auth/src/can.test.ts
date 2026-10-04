import { describe, expect, it } from 'vitest';

import { actorPresence, isSameActor } from './can.js';

/**
 * The questions a ROUTE asks before it does anything, and the one it must not answer itself.
 *
 * ## WHY `actorPresence` EXISTS AT ALL
 *
 * The `authz-ownership` gate flagged `if (userId === null)` in `apps/web/src/app/api/exam/answers/route.ts` as an
 * ownership comparison. **It was a false positive** -- a presence check on a session id, not a comparison of two
 * owners.
 *
 * The gate is textual by design and says so about itself: its patterns are broad, a lint rule would miss the real
 * cases, and it "fails loudly rather than trying to be clever". So the tempting response is to widen the pattern list.
 * **The gate answers that itself: there is no escape hatch, and the fix for a legitimate case is to move the
 * comparison into `packages/auth` and call `can()` -- not to widen the list.**
 *
 * So the question moved here, where it belongs anyway: every route asks whether anybody is signed in, and that should
 * have exactly one answer rather than one per route.
 */
describe('actorPresence', () => {
  it('accepts a real actor id', () => {
    expect(actorPresence('user-1')).toEqual({ ok: true, actorId: 'user-1' });
  });

  it('refuses null and undefined, so a route fails CLOSED', () => {
    for (const absent of [null, undefined]) {
      expect(actorPresence(absent)).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
    }
  });

  it('refuses a BLANK id rather than treating it as anonymous', () => {
    // A cookie that decodes to "" is a malformed credential, not a clean unauthenticated request -- and reporting it as
    // the latter makes a broken session indistinguishable from no session in a log, which is the harder one to notice.
    expect(actorPresence('')).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
    expect(actorPresence('   ')).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
  });

  it('refuses a non-string, so a number cannot become an actor by accident', () => {
    expect(actorPresence(7 as unknown as string).ok).toBe(false);
  });
});

describe('isSameActor is null-safe on BOTH sides', () => {
  it('refuses when the owner is absent, including when both sides are absent', () => {
    // The case a bare `actorId === ownerId` gets wrong: `null === null` reports an ORPHANED row as the actor's own,
    // which is the direction that grants access.
    expect(isSameActor(null, null)).toBe(false);
    expect(isSameActor('user-1', null)).toBe(false);
    expect(isSameActor(null, 'user-1')).toBe(false);
  });

  it('accepts a genuine match and refuses a mismatch', () => {
    expect(isSameActor('user-1', 'user-1')).toBe(true);
    expect(isSameActor('user-1', 'user-2')).toBe(false);
  });
});
