import type { Actor } from '@orrery/auth/types';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from './index.js';
import { readGradebook, readSubmissions } from './report-queries.js';

const teacher: Actor = { id: 't', roles: ['teacher'], mfaVerified: true, suspended: false };

describe('P11 reporting cursor reads', () => {
  it('a 5,000-member gradebook fetches only the demanded roster window with a keyset', async () => {
    const rosterReads: { where: { id?: { gt: string } }; take: number; orderBy: unknown }[] = [];
    const findMany = vi.fn(async (query) => {
      if (query.select.classroomId) return [{ classroomId: 'room', role: 'OWNER' }];
      rosterReads.push(query);
      const after = Number(query.where.id?.gt ?? -1);
      return Array.from({ length: Math.min(query.take, 4999 - after) }, (_, i) => ({
        id: String(after + i + 1).padStart(4, '0'),
        userId: `s${after + i + 1}`,
        displayNameOverride: null,
        user: { name: 'Name' },
      }));
    });
    const tx = {
      examAttempt: { findMany: vi.fn(async () => []) },
      assignmentStudentOverride: { findMany: async () => [] },
    };
    const db = {
      classroom: { findUnique: async () => ({ id: 'room', ownerId: 't', archivedAt: null }) },
      enrollment: { findMany, findFirst: async () => ({ id: 'owner-membership' }) },
      assignment: {
        findMany: async () => [
          {
            id: 'a',
            titleOverride: null,
            weight: 1,
            latePenaltyPercent: 0,
            availableUntil: null,
            resource: { title: 'A' },
            resourceVersion: { _count: { questions: 60 } },
          },
        ],
      },
      $transaction: async (body: (value: typeof tx) => unknown) => body(tx),
    } as unknown as PrismaClient;
    const source = readGradebook(
      db,
      teacher,
      { classroomId: 'room' },
      { now: () => 20, monotonic: () => 0 },
    );
    expect(rosterReads).toHaveLength(0);
    for (let i = 0; i < 100; i++)
      expect((await source.next()).value).toMatchObject({ studentId: `s${i}` });
    expect(rosterReads).toHaveLength(1);
    expect(rosterReads[0]).toMatchObject({ take: 100, orderBy: { id: 'asc' } });
    expect((await source.next()).value).toMatchObject({ studentId: 's100' });
    expect(rosterReads).toHaveLength(2);
    expect(rosterReads[1]?.where.id).toEqual({ gt: '0099' });
    await source.return(undefined);
    expect(rosterReads).toHaveLength(2);
  });
  it('submissions use response keysets and per-attempt released membership at every page', async () => {
    const responseReads: Record<string, unknown>[] = [];
    const db = {
      classroom: { findUnique: async () => ({ id: 'room', ownerId: 't', archivedAt: null }) },
      enrollment: {
        findMany: async () => [{ classroomId: 'room', role: 'OWNER' }],
        findFirst: async () => ({ id: 'owner-membership' }),
      },
      questionResponse: {
        findMany: async (query: Record<string, unknown>) => {
          responseReads.push(query);
          return responseReads.length > 1
            ? []
            : Array.from({ length: 100 }, (_, i) => ({
                id: `r${String(i).padStart(3, '0')}`,
                questionId: 'q',
                position: i,
                answer: 'text',
                attempt: {
                  id: 'a',
                  assignmentId: 'assignment',
                  studentId: 's',
                  submittedAt: null,
                  submissionReceipt: null,
                },
              }));
        },
      },
    } as unknown as PrismaClient;
    const source = readSubmissions(db, teacher, {
      classroomId: 'room',
      assignmentId: 'assignment',
      studentId: 's',
    });
    for (let i = 0; i < 100; i++) await source.next();
    expect(responseReads).toHaveLength(1);
    await source.next();
    expect(responseReads[1]).toMatchObject({
      take: 100,
      orderBy: { id: 'asc' },
      where: {
        id: { gt: 'r099' },
        attempt: {
          classroomId: 'room',
          assignmentId: 'assignment',
          studentId: 's',
          purpose: 'GRADED',
          releaseMembers: { some: { batch: { status: 'RELEASED' } } },
        },
      },
    });
  });
});
