/**
 * The email outbox drain.  (P4-T7)
 *
 * ## This is the ONLY place in the codebase that sends an email
 *
 * `plans/12` §7: "All sending is queued, never inline. A slow email provider must never delay a
 * page render or an autosave." So the rule is enforced by a fact about the module graph: the
 * web app has no transport and no send function to call, and this file runs in the `worker`
 * process, which is deployed and scaled independently of `web` for exactly this reason.
 *
 * ## WHY THE DRAIN IS PURE AND THE WORKER IS THIN
 *
 * `drainOnce` takes a `transport` and returns a report. It opens no connection, reads no
 * environment, and starts no timer, so the whole thing — including "a provider that throws on the
 * third message" and "a provider that never returns" — is testable without a network or a
 * database. `runOutboxJob` is the part that knows about the world, and it is four lines long.
 *
 * ## A THROWN TRANSPORT IS A FAILED MESSAGE, not a failed drain
 *
 * The first version had one `try` around the whole batch, so a provider that threw on the third
 * message marked nothing and returned — the queue stalled and the failure looked like success. Now
 * each message is settled on its own: a throw is `markFailed` for that message, and the drain
 * carries on. One bad address must not stop the school receiving anything at all.
 *
 * ## A TRANSPORT THAT NEVER RETURNS MUST NOT WEDGE THE QUEUE
 *
 * A provider that hangs is worse than one that throws, because a throw unwinds and a hang does
 * not. The claim happens BEFORE the send, so a crashed worker leaves rows in `SENDING`; that is
 * what `releaseStaleClaims` is for, and it runs at the start of every drain. The alternative —
 * sending before claiming — would send twice after a crash, which is how people get two copies
 * of the same "your results are out".
 */

import { type Clock, systemClock } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import {
  claimDueMessages,
  markFailed,
  markSent,
  releaseStaleClaims,
} from '@orrery/db/notifications';

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface EmailTransport {
  /** Rejecting is a normal outcome and must be catchable by the drain, not crash it. */
  send(message: OutgoingEmail): Promise<void>;
}

export interface DrainReport {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly releasedStale: number;
}

const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Claim, send, settle. Once.
 *
 * `transport` is injected and required. There is no default transport, and that is deliberate:
 * a default would be a function that can send from a test, and a test that can send from a test
 * is one `vi.mock` away from sending in production.
 */
export async function drainOnce(
  db: ReturnType<typeof getPrisma>,
  transport: EmailTransport,
  clock: Clock = systemClock,
  batch = 50,
): Promise<DrainReport> {
  const now = new Date(clock.now());

  // First, rescue anything a previous run left claimed. A worker killed mid-send leaves rows in
  // SENDING forever otherwise, and those are exactly the messages a student is waiting for.
  const releasedStale = await releaseStaleClaims(db, new Date(now.getTime() - STALE_AFTER_MS));

  const due = await claimDueMessages(db, now, batch);
  let sent = 0;
  let failed = 0;

  for (const message of due) {
    const payload = message.payload as { readonly title?: string; readonly body?: string };
    try {
      await transport.send({
        to: message.toEmail,
        // `title` is the notification's title and the email's SUBJECT. The first version used
        // `template` here, which is a policy name like `RESULTS_RELEASED` and would have put
        // "RESULTS_RELEASED" in the subject line of every real email.
        subject: payload.title ?? message.template,
        body: payload.body ?? '',
      });
      await markSent(db, message.id, clock);
      sent += 1;
    } catch (error) {
      // Settled per message. One bounced address must not stop the other thirty-nine.
      await markFailed(db, message.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }

  return { claimed: due.length, sent, failed, releasedStale };
}

/** The worker-facing half. The only part that knows about a clock or a real transport. */
export async function runOutboxJob(transport: EmailTransport): Promise<DrainReport> {
  return drainOnce(getPrisma(), transport, systemClock);
}
