/**
 * Notification policy.  (P4-T7)
 *
 * ## What this module is FOR
 *
 * `plans/12` §7 is a table of seven events, three channels, and four rules. The rules are the
 * part with teeth, and each of them fails in a way that is only visible if it is written down as
 * a decision rather than as an `if` somewhere in a service:
 *
 *  · **Everything is deduped on `(userId, kind, refId)`.** A school re-imports a roster; a
 *    teacher clicks publish twice. Without a dedupe the second one is a second email and the
 *    first thing a user does is turn them all off, which fixes the symptom by breaking the
 *    product.
 *  · **All sending is queued, never inline.** "A slow email provider must never delay a page
 *    render or an autosave." A send inside a request handler is a remote dependency on the exam
 *    path, and the exam path is the one thing in this product that cannot be slow.
 *  · **Global quiet hours and a per-user digest preference.**
 *  · **One-click unsubscribe on every email, and unsubscribing never disables in-app
 *    notifications a user needs for their coursework.**
 *
 * ## The unsubscribe rule is the one people get wrong
 *
 * "Unsubscribe" reads like a global mute, and implementing it as one is how a school ends up
 * with students who never see "your results are out" because they once marked an assignment
 * newsletter as spam. So it is structurally impossible here: there is exactly ONE opt-out flag
 * and it is named `emailOptOut`, it is consulted only by the email path, and the in-app path
 * (`notify`) has no parameter that can carry it. A test asserts a notification is still written
 * for a user who has unsubscribed from every email they will ever receive.
 *
 * ## TIMEZONES, WITHOUT A DEPENDENCY
 *
 * Quiet hours are a LOCAL time window — "do not email me between 21:00 and 07:00" means 21:00
 * where the recipient is, and for a platform used across a school year that is not the same
 * instant as 21:00 in the server's zone. Converting needs a timezone database, and
 * `plans/00` §RN makes adding one a dedicated reviewed task, not a drive-by.
 *
 * `Intl.DateTimeFormat` is already in the runtime and already knows about IANA zones, so the
 * conversion uses it. Finding the END of a quiet window is the awkward half — the inverse of
 * "UTC to local" — and the first version of this file reached for a hand-rolled offset table,
 * which is wrong at every daylight-saving boundary. Instead it steps forward in one-minute
 * increments and asks `Intl` the local time at each step, which is bounded by the window length
 * (ten hours, 600 steps) and is correct across DST because it never computes an offset at all.
 * That is a deliberately unfashionable algorithm chosen because it is right rather than clever.
 */

/** The seven events in `plans/12` §7. */
export const NOTIFICATION_KINDS = [
  'INVITATION_SENT',
  'ASSIGNMENT_PUBLISHED',
  'RESULTS_RELEASED',
  'GRADING_NEEDED',
  'DEADLINE_APPROACHING',
  'MEMBERSHIP_CHANGED',
  'ROSTER_IMPORT_APPLIED',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type Channel = 'IN_APP' | 'EMAIL';

export interface KindPolicy {
  readonly kind: NotificationKind;
  readonly channels: readonly Channel[];
  /**
   * Whether an EMAIL for this kind is held for the digest instead of going out at once.
   *
   * §7: "digest after 3 invitations to the same address" and "Immediate for a time-boxed exam,
   * digest otherwise". The two are different rules, so this is a number and not a boolean — and
   * the invitation rule counts PER ADDRESS while the assignment rule is per event.
   */
  readonly digest: 'NEVER' | 'AFTER_N_TO_SAME_ADDRESS' | 'UNLESS_TIMEBOXED';
  /** The `n` for `AFTER_N_TO_SAME_ADDRESS`. */
  readonly digestThreshold?: number;
  /**
   * Whether quiet hours apply. §7 says "Grading needed — in-app only. Never emailed per
   * response; it would be noise", so it is never emailed and the question cannot arise. A kind
   * that is IN_APP only has `false` here because there is no email to hold.
   */
  readonly quietHoursApply: boolean;
  /** Whether the email carries an unsubscribe link. Every email does, but the flag is data. */
  readonly unsubscribeLink: boolean;
}

const POLICY: Readonly<Record<NotificationKind, KindPolicy>> = {
  INVITATION_SENT: {
    kind: 'INVITATION_SENT',
    channels: ['IN_APP', 'EMAIL'],
    // "digest after 3 invitations to the same address" — a school inviting a year group in one
    // sitting should get one email, not forty.
    digest: 'AFTER_N_TO_SAME_ADDRESS',
    digestThreshold: 3,
    quietHoursApply: true,
    unsubscribeLink: true,
  },
  ASSIGNMENT_PUBLISHED: {
    kind: 'ASSIGNMENT_PUBLISHED',
    channels: ['IN_APP', 'EMAIL'],
    // "Immediate for a time-boxed exam, digest otherwise." An exam with a running clock is the
    // one case where waiting until morning is not a preference.
    digest: 'UNLESS_TIMEBOXED',
    quietHoursApply: true,
    unsubscribeLink: true,
  },
  RESULTS_RELEASED: {
    kind: 'RESULTS_RELEASED',
    channels: ['IN_APP', 'EMAIL'],
    // "The single most-wanted notification we send." It is never batched behind a digest.
    digest: 'NEVER',
    quietHoursApply: false,
    unsubscribeLink: true,
  },
  GRADING_NEEDED: {
    kind: 'GRADING_NEEDED',
    channels: ['IN_APP'],
    // "Never emailed per-response; it would be noise." In-app only, and that is the whole
    // mechanism: there is no email path for a teacher to configure their way into.
    digest: 'NEVER',
    quietHoursApply: false,
    unsubscribeLink: false,
  },
  DEADLINE_APPROACHING: {
    kind: 'DEADLINE_APPROACHING',
    channels: ['IN_APP'],
    // "Student-initiated; respects the student's timezone and quiet hours." In-app, and the
    // timezone matters for the digest of everything else this student signs up for.
    digest: 'NEVER',
    quietHoursApply: false,
    unsubscribeLink: false,
  },
  MEMBERSHIP_CHANGED: {
    kind: 'MEMBERSHIP_CHANGED',
    channels: ['IN_APP'],
    // "Always." In-app always, no email — which is also the right default, because the person
    // who most needs to know they were removed from a class is the person least likely to want
    // an email about it afterwards.
    digest: 'NEVER',
    quietHoursApply: false,
    unsubscribeLink: false,
  },
  ROSTER_IMPORT_APPLIED: {
    kind: 'ROSTER_IMPORT_APPLIED',
    channels: ['IN_APP'],
    // "With the error report attached." A report is a document, not a message, so it travels
    // with the in-app record rather than as an attachment in an email.
    digest: 'NEVER',
    quietHoursApply: false,
    unsubscribeLink: false,
  },
};

export function policyFor(kind: NotificationKind): KindPolicy {
  const policy = POLICY[kind];
  // A typo at a call site is a type error, and this is the runtime half of the same statement.
  // Returning `undefined` would let it travel three frames before something read
  // `policy.channels.length` and threw a message with no kind in it.
  if (policy === undefined) throw new Error(`policyFor: unknown notification kind ${String(kind)}`);
  return policy;
}

/**
 * The dedupe key, and the plan's exact triple.
 *
 * `(userId, kind, refId)` — not `(userId, kind)` and not `(toEmail, kind)`. The difference
 * matters: a student in two classes gets one `ASSIGNMENT_PUBLISHED` per assignment, and `refId`
 * is what makes that one. Including a timestamp would make every call unique and dedupe nothing.
 */
export function dedupeKey(userId: string, kind: NotificationKind, refId: string): string {
  return `${userId}:${kind}:${refId}`;
}

export interface EmailPreferences {
  /** The ONE opt-out. It governs email and nothing else — see the module comment. */
  readonly emailOptOut: boolean;
  readonly digestIntervalMinutes: number;
  /** Minutes from local midnight. `1440` means the window is closed. */
  readonly quietFromMinute: number;
  readonly quietToMinute: number;
  readonly timezone: string;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  emailOptOut: false,
  digestIntervalMinutes: 60,
  // 21:00 to 07:00 local, which is the most-quoted window and a defensible default. It is a
  // PREFERENCE and the user can change it; what matters is that it is explicit rather than
  // inherited from the server's timezone.
  quietFromMinute: 21 * 60,
  quietToMinute: 7 * 60,
  timezone: 'UTC',
};

/**
 * Local minutes-since-midnight for an instant, in a named IANA zone.
 *
 * An unknown zone falls back to UTC rather than throwing. A corrupt value in one preferences row
 * must not stop the queue drain, and `Intl` throws a `RangeError` on a zone it does not know —
 * which is exactly the failure this replaces.
 */
export function localMinuteOfDay(instant: Date, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // `hour12: false` yields 24 for midnight in some ICU versions, and 24:00 is 00:00.
  return (hour % 24) * 60 + minute;
}

/**
 * Formatters, cached per zone.
 *
 * This is a PERFORMANCE fix with an embarrassing cause: `endOfWindow` asks for the local time at
 * up to 1,440 successive instants, and each question used to build a fresh `Intl.DateTimeFormat`.
 * Formatter construction is one of the slower things in the platform — milliseconds each with a
 * full ICU — so a ten-second quiet window cost seconds of CPU, and a queue drain over a few
 * hundred recipients spent all its time building formatters. One formatter per zone, built once.
 *
 * The map is unbounded on purpose: the keys are IANA zone names, of which there are about six
 * hundred, so it cannot grow without limit, and a cache with a size limit on a set that small is
 * a cache that evicts the zone the current user is in.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The zone to use, or `UTC` when the stored one is not a zone this runtime knows. */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  const options = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
  try {
    const built = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone });
    FORMATTERS.set(timezone, built);
    return built;
  } catch {
    // A corrupt value in one preferences row must not stop the queue drain, and `Intl` throws a
    // `RangeError` on a zone it does not know. UTC is a defensible answer and never throws. The
    // original is NOT cached under its own name, so a zone this runtime does not recognise is
    // retried rather than permanently remembered as broken.
    const utc = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
    FORMATTERS.set('UTC', utc);
    return utc;
  }
}

export type QuietDecision =
  | { readonly quiet: false }
  | { readonly quiet: true; readonly resumeAt: Date; readonly minutesRemaining: number };

/**
 * Is this instant inside the window? The NON-RECURSIVE question.
 *
 * ## Why this is a separate function, and the bug that forced it
 *
 * The first version had `endOfWindow` ask `quietWindow(cursor)` whether the cursor was still
 * quiet — and `quietWindow` computes a `resumeAt` by calling `endOfWindow` on anything inside
 * the window. So every probe re-entered the search, and finding the end of a window recursed
 * without bound: each level advanced the clock a minute and started a fresh 1,440-step loop, and
 * the suite simply stopped.
 *
 * The fix is not a depth limit or a `visited` set. It is noticing that "is this instant quiet?"
 * and "when does the window end?" are two different questions, and only the second one needs to
 * search. `endOfWindow` asks this one, which cannot recurse because it knows nothing about
 * `resumeAt`.
 */
function isInsideWindow(instant: Date, prefs: EmailPreferences): boolean {
  const { quietFromMinute: from, quietToMinute: to } = prefs;
  // An equal pair is a CLOSED window, not 24 hours of silence. `from === to` almost always means
  // a preference that was never set, and reading that as "always quiet" loses every email the
  // school sends.
  if (from === to) return false;
  const minute = localMinuteOfDay(instant, prefs.timezone);
  return from > to ? minute >= from || minute < to : minute >= from && minute < to;
}

/** Is `now` inside this user's quiet window, and when does it end? */
export function quietWindow(now: Date, prefs: EmailPreferences): QuietDecision {
  if (!isInsideWindow(now, prefs)) return { quiet: false };
  const minute = localMinuteOfDay(now, prefs.timezone);
  const { quietFromMinute: from, quietToMinute: to } = prefs;
  // Minutes left on the 1,440-minute circle. A wrapping window has TWO legs, and the distance
  // left differs on each: on the evening leg it is the distance to midnight PLUS the distance
  // from the start of the day to `to`, and on the morning leg it is simply `to - minute`.
  //
  // The first version used the evening formula for both, so 06:00 in a 21:00-07:00 window
  // reported 25 hours remaining instead of one hour. The test caught it and the copy on screen
  // would have said a quiet window ends tomorrow evening.
  const remaining = from > to && minute >= from ? 1_440 - minute + to : to - minute;
  return { quiet: true, resumeAt: endOfWindow(now, prefs), minutesRemaining: remaining };
}

/**
 * The first instant at or after `start` that is OUTSIDE the window, found by asking `Intl`.
 *
 * Stepping a minute at a time is O(window length) — 600 steps for a ten-hour window — which is
 * nothing next to a database round trip, and it is CORRECT across daylight saving, which a
 * cached UTC offset is not: on the day the clocks change, "07:00 local" is a different instant
 * than it was the day before, and any offset table in the code is wrong twice a year. The bound
 * is 1,440 steps so a malformed preference cannot spin here.
 */
function endOfWindow(start: Date, prefs: EmailPreferences): Date {
  const step = 60_000;
  let cursor = new Date(start.getTime());
  for (let i = 0; i < 1_440; i += 1) {
    cursor = new Date(cursor.getTime() + step);
    if (!isInsideWindow(cursor, prefs)) return cursor;
  }
  // Unreachable for any preference that is not degenerate. The step bound guarantees we get here
  // rather than hang, which is the whole point of having one: a window that never ends is a bug,
  // and returning a day from now degrades to "delayed" rather than to "never sent".
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/** What the queue should do with one email right now. */
export type SendPlan =
  | { readonly action: 'SEND_NOW' }
  | { readonly action: 'HOLD_FOR_QUIET_HOURS'; readonly resumeAt: Date }
  | { readonly action: 'DIGEST_NOW' }
  | { readonly action: 'SKIP_OPTED_OUT' };

/**
 * Decide one email, from the policy and the preferences.
 *
 * The order of the checks is the design, and it is worth stating because the obvious order is
 * wrong:
 *
 *   1. **opted out** — a person who unsubscribed does not get a digest either. Checking quiet
 *      hours first would put their address in a digest queue they never asked to be in.
 *   2. **not an email kind** — `GRADING_NEEDED` has no email channel at all, so there is nothing
 *      to decide. This is how "never emailed per-response" is enforced rather than merely
 *      intended.
 *   3. **digest** — §7's two digest rules.
 *   4. **quiet hours** — last, because holding a DIGEST for quiet hours is wrong: a digest is
 *      already a batch, and pushing it past the morning means it arrives during the school day
 *      anyway, later and no less intrusive than the thing digesting was meant to prevent.
 */
export function planEmail(input: {
  readonly kind: NotificationKind;
  readonly now: Date;
  readonly prefs: EmailPreferences;
  /** How many of this kind are already queued to THIS ADDRESS. `plans/12` §7. */
  readonly alreadyQueuedToAddress?: number;
  /** True when the assignment is a time-boxed exam. */
  readonly timeboxed?: boolean;
}): SendPlan {
  if (input.prefs.emailOptOut) return { action: 'SKIP_OPTED_OUT' };
  const policy = policyFor(input.kind);
  if (!policy.channels.includes('EMAIL')) return { action: 'SKIP_OPTED_OUT' };

  switch (policy.digest) {
    case 'NEVER':
      return planQuiet(input, policy);

    case 'AFTER_N_TO_SAME_ADDRESS': {
      const threshold = policy.digestThreshold ?? 3;
      if ((input.alreadyQueuedToAddress ?? 0) + 1 >= threshold) {
        // The third invitation is the digest trigger, and the digest goes NOW rather than waiting
        // out an interval: a school inviting forty students should get one email within a minute
        // of the third, not at the end of the hour. And it is not held for quiet hours, because a
        // digest pushed to the morning arrives during the school day anyway.
        return { action: 'DIGEST_NOW' };
      }
      return planQuiet(input, policy);
    }

    case 'UNLESS_TIMEBOXED':
      // An exam with a running clock is the one case where waiting is not a preference.
      if (input.timeboxed === true) return { action: 'SEND_NOW' };
      return planQuiet(input, policy);
  }
}

function planQuiet(
  input: { readonly now: Date; readonly prefs: EmailPreferences },
  policy: KindPolicy,
): SendPlan {
  if (!policy.quietHoursApply) return { action: 'SEND_NOW' };
  const quiet = quietWindow(input.now, input.prefs);
  if (!quiet.quiet) return { action: 'SEND_NOW' };
  return { action: 'HOLD_FOR_QUIET_HOURS', resumeAt: quiet.resumeAt };
}

/** The unsubscribe link. One per user, not per message, so it can be revoked once. */
export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}

export interface TemplateContext {
  readonly recipientName: string;
  readonly classroomName: string;
  readonly detail: string;
  /** Present for a time-boxed exam, and the reason it bypasses the digest. */
  readonly timeboxed?: boolean;
  readonly href?: string;
}

/**
 * Render a kind into a subject and a body.
 *
 * Plain text, deliberately. An HTML email is a second renderer with its own escaping rules, and
 * a notification body is short enough that the alternative is a layout nobody asked for. The
 * unsubscribe line is appended by the caller, not here, because it needs the origin and the
 * user's token and this function has neither.
 */
export function renderTemplate(
  kind: NotificationKind,
  context: TemplateContext,
): { readonly subject: string; readonly body: string } {
  switch (kind) {
    case 'INVITATION_SENT':
      return {
        subject: `You have been added to ${context.classroomName}`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'ASSIGNMENT_PUBLISHED':
      return {
        subject: `New work in ${context.classroomName}${context.timeboxed === true ? ' — it is timed' : ''}`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'RESULTS_RELEASED':
      return {
        subject: `Your results for ${context.classroomName} are available`,
        // "The single most-wanted notification we send" — so it says so, in the first line.
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'GRADING_NEEDED':
      return {
        subject: `${context.classroomName}: responses to mark`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'DEADLINE_APPROACHING':
      return {
        subject: `Due soon in ${context.classroomName}`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'MEMBERSHIP_CHANGED':
      return {
        subject: `Your membership of ${context.classroomName} changed`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
    case 'ROSTER_IMPORT_APPLIED':
      return {
        subject: `Roster import finished for ${context.classroomName}`,
        body: `${context.recipientName},\n\n${context.detail}\n\nClass: ${context.classroomName}`,
      };
  }
}
