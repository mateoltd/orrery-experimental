/**
 * Impersonation.  (P1-T10)
 *
 * The done-when, checked in the packet's own order: a write attempted while impersonating is
 * refused with a clear code; the banner cannot be dismissed; the user is notified; and BOTH
 * the audit stream and the notification inbox carry the event.
 *
 * The scenarios are written from the perspective of the people involved, because the failure
 * modes here are social rather than technical. The dangerous one is not "the check was
 * skipped" — it is "the check worked, and support staff concluded the student's account was
 * broken, and told the student so".
 */

import { MINUTE, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  checkImpersonation,
  guardRequest,
  IMPERSONATION_AUDIT_ACTION,
  IMPERSONATION_HEADER,
  IMPERSONATION_LIMIT,
  type ImpersonationState,
  impersonationAuditEntry,
  impersonationBanner,
  impersonationNotice,
  isSafeMethod,
  startImpersonation,
  WRITE_DENIED_CODE,
} from '../impersonation.js';

const T0: Millis = 1_700_000_000_000;

const state = (over: Partial<ImpersonationState> = {}): ImpersonationState => ({
  byUserId: 'adm-1',
  byDisplayName: 'Sam Okafor',
  targetUserId: 's-1',
  targetDisplayName: 'Ada Lovelace',
  startedAt: T0,
  expiresAt: T0 + IMPERSONATION_LIMIT,
  reason: 'Ticket SUP-412: student reports a missing submission',
  ...over,
});

const admin = {
  actorId: 'adm-1',
  actorRoles: ['platformAdmin'],
  targetUserId: 's-1',
  targetIsActive: true,
  alreadyActive: 0,
  now: T0,
};

describe('an impersonation is READ-ONLY, and that is the whole point', () => {
  it('refuses every mutating method with a clear code', () => {
    // An impersonated write is indistinguishable from a compromised admin session. From the
    // database's point of view a row changed while impersonating is a row the admin changed.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const verdict = guardRequest({ method, state: state(), now: T0 });
      expect(verdict.allowed, `method=${method}`).toBe(false);
      if (!verdict.allowed) expect(verdict.code).toBe(WRITE_DENIED_CODE);
    }
  });

  it('refuses an UNKNOWN method, because the safe list is an allowlist', () => {
    // A permissive default would make the read-only guarantee depend on somebody remembering
    // to update a list. A custom verb, or a method added in a future HTTP version, is a write
    // until proven otherwise.
    for (const method of ['PROPFIND', 'LOCK', 'PURGE', 'MKCALENDAR', 'WEIRD']) {
      expect(isSafeMethod(method), `method=${method}`).toBe(false);
      expect(guardRequest({ method, state: state(), now: T0 }).allowed, method).toBe(false);
    }
  });

  it('allows the four safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      expect(guardRequest({ method, state: state(), now: T0 }).allowed, method).toBe(true);
    }
  });

  it('is case-insensitive, because a lowercased verb must not become a write', () => {
    // The opposite failure: a framework lowercases the method, the check misses, and a POST
    // becomes a "safe" request.
    expect(isSafeMethod('get')).toBe(true);
    expect(isSafeMethod('post')).toBe(false);
  });

  it('the message explains the real reason rather than saying "permission denied"', () => {
    // A generic message here is what makes support staff conclude the STUDENT'S ACCOUNT is
    // broken, and tell the student that.
    const verdict = guardRequest({ method: 'POST', state: state(), now: T0 });
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.message).toContain('read-only');
    expect(verdict.message).toContain('administrator');
    expect(verdict.message.toLowerCase()).not.toContain('permission denied');
  });

  it("and the check does not depend on the actor's roles at all", () => {
    // A check that ran AFTER authorisation could be satisfied by a role the impersonated user
    // holds. Running BEFORE it means no role can help, which is the point of the ordering.
    const asTeacher = state({ targetDisplayName: 'A Teacher' });
    expect(guardRequest({ method: 'POST', state: asTeacher, now: T0 }).allowed).toBe(false);
  });
});

describe('15 minutes, hard', () => {
  it('starts with a fixed expiry', () => {
    const verdict = startImpersonation(admin);
    expect(verdict).toEqual({ ok: true, until: T0 + IMPERSONATION_LIMIT });
    expect(IMPERSONATION_LIMIT).toBe(15 * MINUTE);
  });

  it('is LIVE at 14:59 and DEAD at 15:00', () => {
    expect(checkImpersonation(state(), T0 + 14 * MINUTE + 59_000).active).toBe(true);
    expect(checkImpersonation(state(), T0 + IMPERSONATION_LIMIT).active).toBe(false);
  });

  it('does NOT slide, so activity cannot keep it alive', () => {
    // A sliding window is how "15 minutes" becomes "the rest of the afternoon". The expiry is
    // a fixed instant set at start and never recomputed.
    const s = state();
    let now = T0;
    for (let i = 0; i < 14; i += 1) {
      now += MINUTE;
      expect(checkImpersonation(s, now).active, `at minute ${i + 1}`).toBe(true);
    }
    expect(checkImpersonation(s, now + MINUTE).active).toBe(false);
  });

  it('cannot be extended, and the type says so', () => {
    // `canExtend: false` is a literal type, so `if (canExtend)` does not compile. A boolean
    // would compile and would be false at runtime, which is one refactor away from a bug.
    const live = checkImpersonation(state(), T0);
    if (!live.active) throw new Error('expected a live impersonation');
    expect(live.canExtend).toBe(false);
  });

  it('an EXPIRED impersonation stops denying writes, because it is over', () => {
    // The session ends and the admin is back in their own account with their own rights.
    const after = T0 + IMPERSONATION_LIMIT + 1;
    expect(guardRequest({ method: 'POST', state: state(), now: after })).toEqual({
      allowed: true,
      impersonating: false,
    });
  });
});

describe('the ordinary case: no impersonation at all', () => {
  // The overwhelmingly common case, and the first version of this file never tested it — the
  // coverage report found an uncovered branch on `state === null`, which is a good way of
  // saying "you never checked the path every real request takes".
  it('is not active', () => {
    expect(checkImpersonation(null, T0)).toEqual({ active: false });
  });

  it('permits a write, which is the whole point — the gate must not fire on normal traffic', () => {
    // If this ever returned false, every teacher in the school would be unable to mark.
    expect(guardRequest({ method: 'POST', state: null, now: T0 })).toEqual({
      allowed: true,
      impersonating: false,
    });
    expect(guardRequest({ method: 'DELETE', state: null, now: T0 }).allowed).toBe(true);
  });
});

describe('who may start one, and what they may not', () => {
  it('refuses a non-admin', () => {
    expect(startImpersonation({ ...admin, actorRoles: ['teacher'] })).toEqual({
      ok: false,
      reason: 'notAnAdmin',
    });
    expect(startImpersonation({ ...admin, actorRoles: ['reviewer'] })).toEqual({
      ok: false,
      reason: 'notAnAdmin',
    });
  });

  it('refuses impersonating yourself', () => {
    // A no-op that would consume the only slot, and in a demo fixture it is how a "read-only"
    // session ends up looking like an ordinary one.
    expect(startImpersonation({ ...admin, targetUserId: 'adm-1' })).toEqual({
      ok: false,
      reason: 'sameUser',
    });
  });

  it('refuses a suspended target', () => {
    expect(startImpersonation({ ...admin, targetIsActive: false })).toEqual({
      ok: false,
      reason: 'targetSuspended',
    });
  });

  it('allows only ONE at a time', () => {
    // Two at once means an admin can be holding one impersonation while a colleague assumes
    // the other, and neither can tell whose session they are looking at.
    expect(startImpersonation({ ...admin, alreadyActive: 1 })).toEqual({
      ok: false,
      reason: 'tooManyActive',
    });
  });
});

describe('the banner cannot be dismissed', () => {
  it('dismissible is the literal type false, not a runtime flag', () => {
    const banner = impersonationBanner(state(), T0);
    expect(banner.dismissible).toBe(false);
    // A caller passing `true` does not compile.
    expectType<false>(banner.dismissible);
  });

  it('is an ALERT, so a screen-reader user is told — which is their only warning', () => {
    const banner = impersonationBanner(state(), T0);
    expect(banner.role).toBe('alert');
    expect(banner.ariaLive).toBe('assertive');
  });

  it('names both people, the reason, and the time remaining', () => {
    const banner = impersonationBanner(state(), T0);
    expect(banner.heading).toContain('administrator');
    // Both names: "you are looking at someone else's work" is only meaningful if the viewer
    // knows whose it is AND who is looking.
    expect(banner.body).toContain('Ada Lovelace');
    expect(banner.body).toContain('Sam Okafor');
    expect(banner.body).toContain('SUP-412');
    expect(banner.body).toContain('15 minutes');
  });

  it('counts down in whole minutes and never says "0 minutes"', () => {
    expect(impersonationBanner(state(), T0 + 14 * MINUTE + 30_000).body).toContain('1 minute.');
    expect(impersonationBanner(state(), T0 + 14 * MINUTE).body).not.toContain('0 minutes');
  });

  it('has a landmark label, so it is reachable by landmark navigation', () => {
    expect(impersonationBanner(state(), T0).landmarkLabel).toBe(
      'Administrator impersonation in progress',
    );
  });
});

describe('the impersonated user is notified, and so is the audit stream', () => {
  it('the notification goes to the IMPERSONATED user, not the admin', () => {
    const notice = impersonationNotice(state(), T0, 'started');
    expect(notice.toUserId).toBe('s-1');
    expect(notice.toUserId).not.toBe('adm-1');
  });

  it('and it says what happened, who, and why', () => {
    const notice = impersonationNotice(state(), T0, 'started');
    expect(notice.title).toContain('administrator');
    expect(notice.body).toContain('Sam Okafor');
    expect(notice.body).toContain('SUP-412');
    // And it reassures correctly: they could see, they could not change.
    expect(notice.body).toContain('could not change anything');
    expect(notice.body).toContain('unexpected');
  });

  it('a notification exists for the END as well as the start', () => {
    // A start-only signal tells the user something began and never tells them it stopped.
    expect(impersonationNotice(state(), T0, 'ended').kind).toBe('impersonation.ended');
  });

  it('the audit row records the admin, the target and the REASON', () => {
    const entry = impersonationAuditEntry(state(), T0 + 60_000);
    expect(entry.action).toBe(IMPERSONATION_AUDIT_ACTION);
    expect(entry.actorId).toBe('adm-1');
    expect(entry.targetId).toBe('s-1');
    // "Who and when" does not explain anything; the reason is the whole record.
    expect(entry.meta.reason).toContain('SUP-412');
  });

  it('and the two are CORRELATABLE, because they are different readers', () => {
    // Nobody reviewing the inbox is watching the audit stream, and nobody watching the audit
    // stream is the person whose account it was. A signal in only one has failed in the other.
    const notice = impersonationNotice(state(), T0, 'started');
    const audit = impersonationAuditEntry(state(), T0);
    expect(notice.at).toBe(audit.meta.at);
    expect(notice.toUserId).toBe(audit.targetId);
  });

  it('the header marks EVERY request, including the safe ones', () => {
    // A request that bypasses the marker is a request the audit trail cannot explain.
    expect(IMPERSONATION_HEADER).toBe('x-impersonating');
    const safe = guardRequest({ method: 'GET', state: state(), now: T0 });
    expect(safe.allowed && safe.impersonating).toBe(true);
  });
});

/** Compile-time assertion: the literal type is what stops a caller passing `true`. */
function expectType<T>(_value: T): void {}
