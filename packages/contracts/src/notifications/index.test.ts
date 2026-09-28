/**
 * Notification policy.  (P4-T7)
 *
 * ## The four tests that matter
 *
 *  · `unsubscribing never disables the notifications a student needs` — `plans/12` §7's last
 *    rule, and the one that is structurally impossible to get wrong once it is written this way.
 *  · `a quiet window that wraps midnight is not computed backwards` — 21:00 → 07:00 is the
 *    normal case and the easy one to invert.
 *  · `the end of a quiet window survives a daylight-saving change` — the reason the end of a
 *    window is found by asking `Intl` rather than by adding an offset.
 *  · `grading needed is never emailed` — "Never emailed per-response; it would be noise" is
 *    enforced by the kind having no email channel, not by a caller remembering.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_PREFERENCES,
  type EmailPreferences,
  localMinuteOfDay,
  NOTIFICATION_KINDS,
  type NotificationKind,
  planEmail,
  policyFor,
  quietWindow,
  renderTemplate,
  unsubscribeUrl,
} from './index.js';

const at = (iso: string): Date => new Date(iso);

const prefs = (o: Partial<EmailPreferences> = {}): EmailPreferences => ({
  ...DEFAULT_EMAIL_PREFERENCES,
  ...o,
});

describe('notification policy', () => {
  it('every kind in the plan has a policy, and no kind has been invented', () => {
    // Seven events, named from `plans/12` §7's table. A kind added here without a row in the
    // plan is a kind nobody decided the channel for.
    expect([...NOTIFICATION_KINDS].sort()).toEqual([
      'ASSIGNMENT_PUBLISHED',
      'DEADLINE_APPROACHING',
      'GRADING_NEEDED',
      'INVITATION_SENT',
      'MEMBERSHIP_CHANGED',
      'RESULTS_RELEASED',
      'ROSTER_IMPORT_APPLIED',
    ]);
    for (const kind of NOTIFICATION_KINDS) {
      expect(policyFor(kind).kind).toBe(kind);
      expect(policyFor(kind).channels.length).toBeGreaterThan(0);
    }
  });

  it('IN_APP is a channel of every kind, because coursework notices cannot be unsubscribable', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(policyFor(kind).channels, kind).toContain('IN_APP');
    }
  });

  it('unsubscribing never disables the notifications a student needs', () => {
    // The one opt-out is named `emailOptOut`, and the test is that the flag does not exist
    // anywhere else. There is no `optOut` and no `muted` on `EmailPreferences`, so a
    // "preferences" screen has nothing to wire up that could suppress an in-app notification.
    const optedOut: EmailPreferences = prefs({ emailOptOut: true });
    expect(Object.keys(optedOut).sort()).toEqual([
      'digestIntervalMinutes',
      'emailOptOut',
      'quietFromMinute',
      'quietToMinute',
      'timezone',
    ]);

    // A kind that is emailed is skipped. A kind that is not is ALSO skipped for email — and the
    // distinction that matters is that neither of those is the in-app path, which has no
    // preference parameter at all.
    expect(
      planEmail({ kind: 'RESULTS_RELEASED', now: at('2026-09-28T12:00:00Z'), prefs: optedOut }),
    ).toEqual({ action: 'SKIP_OPTED_OUT' });
    expect(planEmail({ kind: 'GRADING_NEEDED', now: at('2026-09-28T12:00:00Z'), prefs })).toEqual({
      action: 'SKIP_OPTED_OUT',
    });
  });

  it('grading needed is IN_APP only, so "never emailed per-response" needs no caller discipline', () => {
    const p = policyFor('GRADING_NEEDED');
    expect(p.channels).toEqual(['IN_APP']);
    expect(p.unsubscribeLink).toBe(false);
    // Even with an address, no email is planned. There is no code path to get wrong.
    expect(
      planEmail({ kind: 'GRADING_NEEDED', now: at('2026-09-28T12:00:00Z'), prefs: prefs() }),
    ).toEqual({ action: 'SKIP_OPTED_OUT' });
  });

  it('a quiet window that wraps midnight is not computed backwards', () => {
    const p = prefs({ timezone: 'UTC', quietFromMinute: 21 * 60, quietToMinute: 7 * 60 });
    // 22:00 UTC is inside. 06:00 UTC is inside, which is the half that is easy to miss.
    expect(quietWindow(at('2026-09-28T22:00:00Z'), p).quiet).toBe(true);
    expect(quietWindow(at('2026-09-29T06:00:00Z'), p).quiet).toBe(true);
    // 12:00 is not. And 07:00 exactly is not, because the window is half-open `[from, to)`.
    expect(quietWindow(at('2026-09-28T12:00:00Z'), p).quiet).toBe(false);
    expect(quietWindow(at('2026-09-29T07:00:00Z'), p).quiet).toBe(false);
    expect(quietWindow(at('2026-09-28T21:00:00Z'), p).quiet).toBe(true);
    expect(quietWindow(at('2026-09-28T20:59:00Z'), p).quiet).toBe(false);
  });

  it('a NON-wrapping window is the plain interval, and an equal pair is CLOSED not eternal', () => {
    const work = prefs({ timezone: 'UTC', quietFromMinute: 9 * 60, quietToMinute: 17 * 60 });
    expect(quietWindow(at('2026-09-28T10:00:00Z'), work).quiet).toBe(true);
    expect(quietWindow(at('2026-09-28T18:00:00Z'), work).quiet).toBe(false);
    // An unset preference has `from === to` by accident more often than by design. Reading that
    // as "always quiet" silently loses every email the school sends.
    const unset = prefs({ quietFromMinute: 0, quietToMinute: 0 });
    expect(quietWindow(at('2026-09-28T03:00:00Z'), unset).quiet).toBe(false);
  });

  it('minutes remaining is honest on both sides of midnight', () => {
    const p = prefs({ timezone: 'UTC', quietFromMinute: 21 * 60, quietToMinute: 7 * 60 });
    const late = quietWindow(at('2026-09-28T22:00:00Z'), p);
    const early = quietWindow(at('2026-09-29T06:00:00Z'), p);
    expect(late.quiet && late.minutesRemaining).toBe(9 * 60);
    expect(early.quiet && early.minutesRemaining).toBe(60);
  });

  it('quiet hours are LOCAL, so the same instant is quiet for one recipient and not another', () => {
    // 22:00 UTC on 28 Sep. Auckland is on NZDT by then (UTC+13), so it is 11:00 there —
    // morning, and not quiet. London is BST (UTC+1), so it is 23:00 there — quiet.
    const instant = at('2026-09-28T22:00:00Z');
    expect(localMinuteOfDay(instant, 'Pacific/Auckland')).toBe(11 * 60);
    expect(localMinuteOfDay(instant, 'Europe/London')).toBe(23 * 60);
    expect(quietWindow(instant, prefs({ timezone: 'Pacific/Auckland' })).quiet).toBe(false);
    expect(quietWindow(instant, prefs({ timezone: 'Europe/London' })).quiet).toBe(true);
  });

  it('the end of a quiet window survives a daylight-saving change', () => {
    // This is the test that decided the algorithm. Europe/London moves to BST on the last Sunday
    // in March, which in 2026 is the 29th, so local 07:00 is UTC 07:00 the day before and UTC
    // 06:00 the day after. A cached UTC offset is a day wrong, twice a year, and quietly so.
    const p = prefs({ timezone: 'Europe/London', quietFromMinute: 21 * 60, quietToMinute: 7 * 60 });

    // 28 March 21:30 UTC is local 21:30 GMT — inside the window. The window ENDS INSIDE THE DST
    // TRANSITION, at local 07:00 on the 29th, which is 06:00 UTC because the clocks moved at
    // 01:00 that morning. This is the case a cached offset cannot express at all: the same
    // "07:00 local" is two different instants either side of 01:00.
    const spanning = quietWindow(at('2026-03-28T21:30:00Z'), p);
    expect(spanning.quiet).toBe(true);
    if (spanning.quiet) {
      expect(spanning.resumeAt.toISOString()).toBe('2026-03-29T06:00:00.000Z');
      // And it is nine and a half hours, not ten: the lost hour is inside the quiet window.
      expect(spanning.minutesRemaining).toBe(9 * 60 + 30);
    }

    // Well after the change: local 07:00 on 5 April is 06:00 UTC.
    const after = quietWindow(at('2026-04-04T21:30:00Z'), p);
    expect(after.quiet).toBe(true);
    if (after.quiet) expect(after.resumeAt.toISOString()).toBe('2026-04-05T06:00:00.000Z');
  });

  it('results released goes at once, even in the small hours, because it is the one people want', () => {
    // §7: "The single most-wanted notification we send." A student who learns their grade at
    // 07:01 instead of 07:00 has not been protected from anything.
    const middleOfTheNight = at('2026-09-29T03:00:00Z');
    expect(policyFor('RESULTS_RELEASED').quietHoursApply).toBe(false);
    expect(planEmail({ kind: 'RESULTS_RELEASED', now: middleOfTheNight, prefs: prefs() })).toEqual({
      action: 'SEND_NOW',
    });
  });

  it('a time-boxed exam email is immediate; ordinary work is held for quiet hours', () => {
    const night = at('2026-09-28T22:00:00Z');
    expect(
      planEmail({ kind: 'ASSIGNMENT_PUBLISHED', now: night, prefs: prefs(), timeboxed: true }),
    ).toEqual({ action: 'SEND_NOW' });
    const held = planEmail({ kind: 'ASSIGNMENT_PUBLISHED', now: night, prefs: prefs() });
    expect(held.action).toBe('HOLD_FOR_QUIET_HOURS');
    if (held.action === 'HOLD_FOR_QUIET_HOURS') {
      expect(held.resumeAt.toISOString()).toBe('2026-09-29T07:00:00.000Z');
    }
    // And during the day it is not held at all.
    expect(
      planEmail({
        kind: 'ASSIGNMENT_PUBLISHED',
        now: at('2026-09-28T12:00:00Z'),
        prefs: prefs(),
      }),
    ).toEqual({ action: 'SEND_NOW' });
  });

  it('the third invitation to an address digests, and the first two do not', () => {
    // §7: "digest after 3 invitations to the same address".
    const noon = at('2026-09-28T12:00:00Z');
    expect(planEmail({ kind: 'INVITATION_SENT', now: noon, prefs: prefs() })).toEqual({
      action: 'SEND_NOW',
    });
    expect(
      planEmail({ kind: 'INVITATION_SENT', now: noon, prefs: prefs(), alreadyQueuedToAddress: 1 }),
    ).toEqual({ action: 'SEND_NOW' });
    expect(
      planEmail({ kind: 'INVITATION_SENT', now: noon, prefs: prefs(), alreadyQueuedToAddress: 2 }),
    ).toEqual({ action: 'DIGEST_NOW' });
  });

  it('an opted-out address is not put into a digest queue it never asked to be in', () => {
    // The order of the checks, tested. Quiet hours first would queue a digest for someone who
    // unsubscribed, and a digest is still email.
    expect(
      planEmail({
        kind: 'INVITATION_SENT',
        now: at('2026-09-28T22:00:00Z'),
        prefs: prefs({ emailOptOut: true }),
        alreadyQueuedToAddress: 5,
      }),
    ).toEqual({ action: 'SKIP_OPTED_OUT' });
  });

  it('an unknown timezone does not throw, it falls back to UTC', () => {
    // A bad value in a preferences row must not take down the queue drain. `Intl` throws a
    // RangeError on an unknown zone, and one corrupt row would stop every notification in the
    // school.
    expect(localMinuteOfDay(at('2026-09-28T22:00:00Z'), 'Not/AZone')).toBe(
      localMinuteOfDay(at('2026-09-28T22:00:00Z'), 'UTC'),
    );
  });

  it('every kind renders a subject and a body that name the classroom and the person', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const rendered = renderTemplate(kind, {
        recipientName: 'Amara',
        classroomName: 'Year 9 Physics',
        detail: 'Something happened.',
      });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body).toContain('Amara');
      expect(rendered.body).toContain('Year 9 Physics');
    }
  });

  it('a time-boxed exam says so in the subject, because "new work" is not urgent', () => {
    const timed = renderTemplate('ASSIGNMENT_PUBLISHED', {
      recipientName: 'Amara',
      classroomName: 'Year 9 Physics',
      detail: 'The online exam opens at 09:00.',
      timeboxed: true,
    });
    expect(timed.subject).toContain('it is timed');
    const untimed = renderTemplate('ASSIGNMENT_PUBLISHED', {
      recipientName: 'Amara',
      classroomName: 'Year 9 Physics',
      detail: 'Read chapter 4.',
    });
    expect(untimed.subject).not.toContain('it is timed');
  });

  it('the unsubscribe link is one per user and survives a trailing slash on the origin', () => {
    expect(unsubscribeUrl('https://orrery.example/', 'tok-1')).toBe(
      'https://orrery.example/notifications/unsubscribe?token=tok-1',
    );
    // And a token with a URL-unsafe character cannot break out of the query string.
    expect(unsubscribeUrl('https://orrery.example', 'a&b=c')).toContain('token=a%26b%3Dc');
  });

  it('policyFor rejects a kind that is not one, rather than returning undefined', () => {
    // A typo in a call site should be a type error, and the runtime guard says so too.
    expect(() => policyFor('NOT_A_KIND' as NotificationKind)).toThrow();
  });
});
