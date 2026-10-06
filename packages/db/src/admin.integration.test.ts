/**
 * Admin suspension: the writer the schema field was waiting for, and its refusals.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import { type AdminActor, suspendUser, unsuspendUser } from './admin.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required: this test suspends rows, not mocks of rows');
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const admin = (id: string): AdminActor => ({ id, roles: ['platformAdmin'] });
const teacher = (id: string): AdminActor => ({ id, roles: ['teacher'] });

async function person(email: string): Promise<string> {
  const created = await prisma().user.create({
    data: { id: randomUUID(), email, emailNormalized: email, name: 'P' },
    select: { id: true },
  });
  return created.id;
}

describe('suspendUser / unsuspendUser', () => {
  it('suspends with a reason, stamps both fields, and writes the audit row', async () => {
    const db = prisma();
    const actorId = await person(`admin-${randomUUID()}@x.example`);
    const targetId = await person(`t-${randomUUID()}@x.example`);
    const outcome = await suspendUser(db, admin(actorId), {
      userId: targetId,
      targetRoles: ['teacher'],
      reason: 'test suspension',
    });
    expect(outcome.ok).toBe(true);
    const row = await db.user.findUnique({
      where: { id: targetId },
      select: { suspendedAt: true, suspendedReason: true },
    });
    expect(row?.suspendedAt).not.toBeNull();
    expect(row?.suspendedReason).toBe('test suspension');
    const audit = await db.auditEvent.findFirst({
      where: { action: 'USER_SUSPENDED', targetId },
      select: { actorId: true },
    });
    expect(audit?.actorId).toBe(actorId);
  });

  it('unsuspend clears BOTH fields, or the reason outlives the suspension', async () => {
    const db = prisma();
    const actorId = await person(`admin-${randomUUID()}@x.example`);
    const targetId = await person(`t-${randomUUID()}@x.example`);
    await suspendUser(db, admin(actorId), { userId: targetId, targetRoles: [], reason: 'r' });
    await unsuspendUser(db, admin(actorId), targetId);
    const row = await db.user.findUnique({
      where: { id: targetId },
      select: { suspendedAt: true, suspendedReason: true },
    });
    expect(row?.suspendedAt).toBeNull();
    expect(row?.suspendedReason).toBeNull();
  });

  it('refuses: non-admin, self-suspension, blank reason, peer admin, missing user', async () => {
    const db = prisma();
    const actorId = await person(`admin-${randomUUID()}@x.example`);
    const targetId = await person(`t-${randomUUID()}@x.example`);
    expect(
      (await suspendUser(db, teacher(actorId), { userId: targetId, targetRoles: [], reason: 'r' }))
        .ok,
    ).toBe(false);
    expect(
      (await suspendUser(db, admin(actorId), { userId: actorId, targetRoles: [], reason: 'r' })).ok,
    ).toBe(false);
    expect(
      (await suspendUser(db, admin(actorId), { userId: targetId, targetRoles: [], reason: '  ' }))
        .ok,
    ).toBe(false);
    expect(
      (
        await suspendUser(db, admin(actorId), {
          userId: targetId,
          targetRoles: ['platformAdmin'],
          reason: 'r',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await suspendUser(db, admin(actorId), {
          userId: randomUUID(),
          targetRoles: [],
          reason: 'r',
        })
      ).ok,
    ).toBe(false);
    expect((await unsuspendUser(db, teacher(actorId), targetId)).ok).toBe(false);
  });
});
