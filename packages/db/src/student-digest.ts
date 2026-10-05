import type { Clock } from '@orrery/clock';
import { quietWindow, unsubscribeUrl } from '@orrery/contracts/notifications';
import { assertNoScoreLeak } from '@orrery/interop';
import type { PrismaClient } from './index.js';
import { ensurePreference, preferencesFor } from './notifications.js';

export interface DigestInstrument {
  readonly attemptId: string;
  readonly title: string;
  readonly status: string;
  readonly released: boolean;
}

/** Instruments only (`D13`); grading progress and mark changes never contribute to copy. */
export function buildStudentDigest(instruments: readonly DigestInstrument[]) {
  const digest = {
    title: 'Your coursework digest',
    items: instruments.map((item) => ({
      title: item.title,
      href: `/attempts/${encodeURIComponent(item.attemptId)}/results`,
      notice:
        item.status === 'FROZEN'
          ? 'Your attempt is paused. Your teacher can reinstate it with a recorded reason.'
          : item.released
            ? 'Results are available.'
            : item.status === 'EXCUSED'
              ? 'You have been excused from this assignment.'
              : item.status === 'MISSING'
                ? 'The assignment window has closed without a submission. Contact your teacher if this needs correcting.'
                : item.status === 'IN_PROGRESS'
                  ? 'Your attempt is in progress.'
                  : item.status === 'NOT_STARTED'
                    ? 'This assignment has not been started.'
                    : 'Your submission is with your teacher. You will be notified when results are released.',
    })),
  };
  assertNoScoreLeak(digest);
  return digest;
}

export async function loadStudentDigest(db: Pick<PrismaClient, 'examAttempt'>, studentId: string) {
  const attempts = await db.examAttempt.findMany({
    where: { studentId, purpose: 'GRADED', status: { not: 'VOIDED' } },
    // `updatedAt` changes on hidden grading and would expose it by reordering the digest.
    distinct: ['assignmentId'],
    orderBy: [{ assignmentId: 'asc' }, { attemptNumber: 'desc' }],
    take: 100,
    select: {
      id: true,
      status: true,
      assignment: { select: { titleOverride: true, resource: { select: { title: true } } } },
      releaseMembers: {
        where: { batch: { status: 'RELEASED' } },
        take: 1,
        select: { batchId: true },
      },
    },
  });
  return buildStudentDigest(
    attempts.map((a) => ({
      attemptId: a.id,
      title: a.assignment.titleOverride ?? a.assignment.resource.title,
      status: a.status,
      released: a.releaseMembers.length > 0,
    })),
  );
}

/** Caller supplies the period, so retries have one stable inbox/outbox identity. */
export async function queueStudentDigest(
  db: PrismaClient,
  input: { studentId: string; period: string; origin: string; clock: Clock },
) {
  if (!input.period.trim()) throw new Error('DIGEST_PERIOD_REQUIRED');
  const digest = await loadStudentDigest(db, input.studentId);
  if (digest.items.length === 0) return { created: false };
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.studentId },
      select: { email: true },
    });
    if (user === null) return { created: false };
    const now = new Date(input.clock.now());
    const prefs = await preferencesFor(tx, input.studentId);
    const { token } = await ensurePreference(tx, input.studentId, input.clock);
    const quiet = quietWindow(now, prefs);
    const refId = `digest:${input.period}`;
    const body = digest.items.map((i) => `${i.title}: ${i.notice}`).join('\n');
    // Unchanged coursework is not news. Without this every student is sent the same lines each
    // interval for ever; with it a digest goes out only when something the student may read has
    // changed -- and hidden marking cannot be that something, because it never reaches the copy.
    const last = await tx.notification.findFirst({
      where: { userId: input.studentId, kind: 'STUDENT_DIGEST' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { body: true },
    });
    if (last?.body === body) return { created: false };
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Notification" (id, "userId", kind, title, body, href, data, "refId", "createdAt")
      VALUES (gen_random_uuid()::text, ${input.studentId}, 'STUDENT_DIGEST', ${digest.title}, ${body}, '/coursework', ${JSON.stringify(digest)}::jsonb, ${refId}, ${now})
      ON CONFLICT ("userId", kind, "refId") DO NOTHING RETURNING id`;
    if (user.email !== null)
      await tx.emailOutbox.upsert({
        where: { dedupeKey: `${input.studentId}:STUDENT_DIGEST:${refId}` },
        update: {},
        create: {
          userId: input.studentId,
          toEmail: user.email,
          template: 'STUDENT_DIGEST',
          dedupeKey: `${input.studentId}:STUDENT_DIGEST:${refId}`,
          status: prefs.emailOptOut ? 'SUPPRESSED' : 'QUEUED',
          scheduledAt: quiet.quiet ? quiet.resumeAt : now,
          createdAt: now,
          payload: {
            title: digest.title,
            body: `${body}\n\nUnsubscribe: ${unsubscribeUrl(input.origin, token)}`,
            items: digest.items,
          },
        },
      });
    return { created: inserted.length > 0 };
  });
}

export function digestPeriod(now: number, intervalMinutes: number): string {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)
    throw new Error('INVALID_DIGEST_INTERVAL');
  return `${intervalMinutes}:${Math.floor(now / (intervalMinutes * 60000))}`;
}

/** Stable user pagination and persisted dedupe make overlap and process restarts harmless. */
export async function runStudentDigestTick(db: PrismaClient, clock: Clock, origin: string) {
  let after: string | null = null;
  let queued = 0,
    failed = 0;
  const now = clock.now();
  for (;;) {
    const students: { id: string }[] = await db.user.findMany({
      where: {
        ...(after === null ? {} : { id: { gt: after } }),
        enrollments: { some: { role: 'STUDENT', status: 'ACTIVE' } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    });
    for (const student of students) {
      try {
        const prefs = await preferencesFor(db, student.id);
        const result = await queueStudentDigest(db, {
          studentId: student.id,
          period: digestPeriod(now, prefs.digestIntervalMinutes),
          origin,
          clock,
        });
        if (result.created) queued += 1;
      } catch {
        failed += 1;
      }
    }
    if (students.length < 100) return { queued, failed };
    after = students[students.length - 1]?.id ?? null;
  }
}
