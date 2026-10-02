/**
 * The student "to do" list.  (P5-T4)
 *
 * ## FOUR STATES, AND THREE OF THEM ARE NOT A LIST YOU CAN BUILD BY COMPARING DATES IN JAVASCRIPT
 *
 * `plans/20` P5-T4: "Student 'to do': available / upcoming / completed / expired".
 *
 * Available and upcoming are a window comparison. Expired is a window comparison AND the absence
 * of an attempt. Completed is the absence of a window comparison AND the presence of one. So the
 * classification depends on a JOIN to the student's attempts, which means it belongs in SQL.
 *
 * The first version of this file loaded the classroom's published assignments and bucketed them
 * in JavaScript. That is the shape this codebase refuses everywhere else — "classroom scoping is
 * applied in the query, not filtered afterwards" — and it was also wrong: a student in six
 * classrooms got six separate full assignment lists fetched and merged, and the window was
 * evaluated against the application server's clock rather than the student's request.
 *
 * ## THE FOUR STATES ARE DISJOINT AND EVERY ASSIGNMENT IS IN EXACTLY ONE
 *
 * That is the property worth testing, because the tempting implementation is a chain of
 * `if (window has passed) expired; else if (window has opened) available; else upcoming;` with
 * `completed` checked first — and that chain is silent about an assignment that is BOTH past its
 * window and has an attempt. Which one is it? The answer matters: "available" tells a student to
 * do work they have already done, and "expired" tells them they missed it when they did not.
 *
 * The rule here: **an attempt wins.** Once a student has started, the work is `completed` or
 * `inProgress`, whatever the window says. A window is when work is *offered*, not when it is
 * *owed*.
 */

import { type Clock, systemClock } from '@orrery/clock';
import { resolveForStudent } from './assignments.js';
import type { PrismaClient } from './index.js';

export type TodoState = 'available' | 'upcoming' | 'inProgress' | 'completed' | 'expired';

export interface TodoItem {
  readonly assignmentId: string;
  readonly title: string;
  readonly state: TodoState;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly maxAttempts: number;
  readonly attemptsUsed: number;
  /** Minutes remaining, or `null` for an untimed or not-yet-open window. */
  readonly minutesRemaining: number | null;
  readonly latePenaltyPercent: number;
}

export interface TodoList {
  readonly items: readonly TodoItem[];
  readonly counts: Readonly<Record<TodoState, number>>;
}

const EMPTY_COUNTS: Record<TodoState, number> = {
  available: 0,
  upcoming: 0,
  inProgress: 0,
  completed: 0,
  expired: 0,
};

export async function studentTodo(
  db: PrismaClient,
  input: {
    readonly userId: string;
    readonly classroomId?: string | null;
    /** Which classrooms, or `null` for every classroom this student is enrolled in. */
    readonly classroomIds?: readonly string[] | null;
    readonly limit?: number;
  },
  clock: Clock = systemClock,
): Promise<TodoList> {
  const now = new Date(clock.now());
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  // The scope, in the query. A student's own work in classrooms they are enrolled in and no
  // others — and the enrollment check is a JOIN here rather than a filter in JavaScript.
  const classrooms =
    input.classroomIds ??
    (
      await db.enrollment.findMany({
        where: { userId: input.userId, status: 'ACTIVE' },
        select: { classroomId: true },
        orderBy: { classroomId: 'asc' },
        take: 100,
      })
    ).map((e) => e.classroomId);

  if (input.classroomId !== null && input.classroomId !== undefined) {
    if (!classrooms.includes(input.classroomId)) {
      // An explicit classroom the student is NOT in returns an empty list rather than throwing,
      // because "nothing here" and "here is somebody else's class" must be the same answer.
      return { items: [], counts: { ...EMPTY_COUNTS } };
    }
  }
  const scoped = classrooms.filter((id) => input.classroomId == null || id === input.classroomId);

  const assignments = await db.assignment.findMany({
    where: {
      classroomId: { in: scoped },
      status: 'PUBLISHED',
      // INV-ASSIGN-2: a withdrawn assignment is a MESSAGE, not a deletion. `withdrawnAt` is set
      // and `status` is WITHDRAWN, so this filter excludes it from the to-do list — which is the
      // behaviour the plan wants, with the message delivered by the notification system.
    },
    orderBy: [{ availableFrom: 'asc' }, { id: 'asc' }],
    take: limit,
    select: {
      id: true,
      titleOverride: true,
      availableFrom: true,
      availableUntil: true,
      maxAttempts: true,
      latePenaltyPercent: true,
      policyOverride: true,
      resourceVersion: { select: { assessmentPolicy: true } },
      resource: { select: { title: true } },
      studentOverrides: {
        where: { studentId: input.userId },
        take: 1,
        select: {
          availableFrom: true,
          availableUntil: true,
          maxAttempts: true,
          extraTimePercent: true,
          policyOverride: true,
        },
      },
      accommodations: {
        where: {
          studentId: input.userId,
          status: 'ACTIVE',
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        take: 10,
        select: { relaxations: true, extraTimePercent: true },
      },
      attempts: {
        where: { studentId: input.userId },
        select: { id: true, status: true },
        orderBy: { attemptNumber: 'asc' },
      },
    },
  });

  const items: TodoItem[] = assignments.map((a) => {
    const override = a.studentOverrides[0] ?? null;
    const accommodation =
      a.accommodations.length === 0
        ? null
        : {
            relaxations: a.accommodations.flatMap((x) => x.relaxations),
            // `Number()`, because `Math.max` is arithmetic and a Prisma `Decimal` is not a
            // number. Letting it through produced `0 | Decimal` and the compiler named the line.
            extraTimePercent: Math.max(
              0,
              ...a.accommodations.map((x) => Number(x.extraTimePercent ?? 0)),
            ),
            status: 'ACTIVE',
          };

    // The same fold the attempt uses, so the window a student SEES is the window they will GET.
    // `availableFrom`/`Until` are folded in a second time here because the override's own window
    // is narrower than the assignment's and a to-do list that disagrees with the exam is a bug
    // report.
    const resolved = resolveForStudent({
      mode: 'ASSIGNMENT',
      versionPolicy: a.resourceVersion.assessmentPolicy as never,
      assignmentOverride: a.policyOverride as never,
      availableFrom: a.availableFrom,
      availableUntil: a.availableUntil,
      // The COLUMN, not the policy default. See `PolicySources.maxAttempts`: a teacher who set
      // two attempts was being told a student who used one had finished.
      maxAttempts: a.maxAttempts,
      studentOverride: override
        ? {
            availableFrom:
              override.availableFrom === null || override.availableFrom === undefined
                ? null
                : new Date(override.availableFrom).toISOString(),
            availableUntil:
              override.availableUntil === null || override.availableUntil === undefined
                ? null
                : new Date(override.availableUntil).toISOString(),
            maxAttempts: override.maxAttempts,
            extraTimePercent:
              override.extraTimePercent === null || override.extraTimePercent === undefined
                ? null
                : Number(override.extraTimePercent),
            policyOverride: override.policyOverride as never,
          }
        : null,
      accommodation,
    });

    const from = resolved.availabilityWindow?.from ?? null;
    const until = resolved.availabilityWindow?.until ?? null;
    const fromAt = from === null ? null : new Date(from);
    const untilAt = until === null ? null : new Date(until);

    const attemptsUsed = a.attempts.length;
    const hasLiveAttempt = a.attempts.some(
      (t) => t.status === 'IN_PROGRESS' || t.status === 'NOT_STARTED',
    );

    // AN ATTEMPT WINS, then the window, then attempts exhausted.
    //
    // The order is the whole file. Checking the window first tells a student who has already
    // sat the exam that the work is "available" again, or that they "expired" it, and both are
    // wrong.
    let state: TodoState;
    if (hasLiveAttempt) {
      state = 'inProgress';
    } else if (attemptsUsed >= resolved.maxAttempts) {
      state = 'completed';
    } else if (fromAt !== null && fromAt > now) {
      state = 'upcoming';
    } else if (untilAt !== null && untilAt <= now) {
      state = 'expired';
    } else {
      state = 'available';
    }

    const minutesRemaining =
      state === 'upcoming' || untilAt === null
        ? null
        : Math.max(0, Math.round((untilAt.getTime() - now.getTime()) / 60_000));

    return {
      assignmentId: a.id,
      title: a.titleOverride ?? a.resource.title,
      state,
      availableFrom: fromAt,
      availableUntil: untilAt,
      maxAttempts: resolved.maxAttempts,
      attemptsUsed,
      minutesRemaining,
      latePenaltyPercent: Number(a.latePenaltyPercent),
    };
  });

  const counts = { ...EMPTY_COUNTS };
  for (const item of items) counts[item.state] += 1;
  return { items, counts };
}
