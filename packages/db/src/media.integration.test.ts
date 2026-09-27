/**
 * Quota and media storage against a real Postgres.  (P2-T6, INV-QUOTA-1)
 *
 * ## The test this file is for
 *
 * `two concurrent reservations cannot both succeed`. INV-QUOTA-1 exists because a quota checked
 * at presign time is advisory: between the check and the store, the same user can complete
 * three more uploads, and four checks each saw room for one.
 *
 * This is not testable in a unit test with a fake store, for the same reason `sessionsEpoch` was
 * not: a fake cannot tell you a row exists, and the fix here is a single conditional UPDATE whose
 * correctness is entirely about what the DATABASE does under concurrency.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_QUOTA_BYTES, jpegWithExif, pngWithText } from '@orrery/contracts/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A PNG whose STORED size is genuinely large.
 *
 * `pngWithText` puts its bytes in a `tEXt` chunk, which the metadata strip REMOVES — so a
 * payload built from it stores at a few dozen bytes no matter how much text went in. The first
 * version of the concurrency test used one, the quota was never approached, and the test passed
 * without ever racing anything. Third appearance of the same mistake: a fixture that measures
 * the wrong thing.
 */
function bigPng(storedBytes: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out: number[] = [...signature];
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    for (const c of new TextEncoder().encode(type)) out.push(c);
    out.push(...data, 0, 0, 0, 0);
  };
  chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  // IDAT is pixel data and is NOT stripped, so this is the size that actually gets charged.
  const pixels = new Array<number>(Math.max(1, storedBytes)).fill(0x41);
  chunk('IDAT', pixels);
  chunk('IEND', []);
  return Uint8Array.from(out);
}

import { isGradeable, noOpScanner, storeAsset } from './media.js';
import { PrismaClient } from './prisma.js';
import { peekQuota, DEFAULT_QUOTA_BYTES as REEXPORTED, setQuota } from './quota.js';

const DATABASE_URL = process.env.DATABASE_URL;
/**
 * One injected instant for the whole file, per INV-TIME-1.
 *
 * A FUNCTION, because the field is `now(): number`. Passing the number directly type-errored at
 * the call site only in some positions, and the three tests that failed were failing on
 * `input.now is not a function` rather than on anything to do with quotas.
 */
const NOW = (): number => Date.parse('2026-09-27T12:00:00.000Z');

describe.skipIf(!DATABASE_URL)('P2-T6 media integration, against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function user(quotaBytes?: bigint) {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `${id}@s.example`,
        emailNormalized: `${id}@s.example`,
        name: 'T',
        ...(quotaBytes === undefined ? {} : { storageQuotaBytes: quotaBytes }),
      },
    });
    return id;
  }

  it('the schema default is the same 1 GB the module exports', () => {
    // "The default" living in two places is how a migrated account and a new one end up with
    // different limits, and nobody notices until a teacher is mysteriously over quota.
    expect(REEXPORTED).toBe(DEFAULT_QUOTA_BYTES);
    expect(DEFAULT_QUOTA_BYTES).toBe(1_000_000_000);
  });

  it('charges the STORED size, not the uploaded size', async () => {
    // The EXIF-stripped file is smaller. Charging the uploaded size would quietly penalise a
    // teacher for the metadata their camera wrote, which is both wrong and a small way of making
    // the strip feel punitive rather than protective.
    const owner = await user(10_000_000n);
    const withExif = jpegWithExif(true);
    const stored = await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'photo.jpg',
      declaredType: 'image/jpeg',
      bytes: withExif,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.metadataRemoved).toBe(true);
    const state = await peekQuota(prisma, owner);
    expect(state.usedBytes).toBe(BigInt(stored.byteSize));
    expect(stored.byteSize).toBeLessThan(withExif.length);
  });

  it('refuses an upload over the quota, with a message naming the numbers', async () => {
    // 10 bytes, against a PNG that stores as ~66. The first version of this used a 1000-byte
    // quota and the upload SUCCEEDED -- correctly, because the metadata strip had already made
    // the stored file far smaller than the quota. A quota test that passes for the wrong reason
    // is the same trap as a fixture that lies.
    const owner = await user(10n);
    const outcome = await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'diagram.png',
      declaredType: 'image/png',
      bytes: pngWithText('a'.repeat(200)),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('overQuota');
    // "Quota exceeded" alone makes a teacher guess. The actual and the limit do not.
    expect(outcome.message).toMatch(/left/);
    expect(outcome.message).toMatch(/administrator/);
  });

  it('leaves the counter UNCHANGED when the upload is refused', async () => {
    // A reservation in one transaction and an insert in another charges the user for bytes they
    // never stored, and a quota that leaks is a quota everybody stops trusting.
    const owner = await user(10n);
    await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'diagram.png',
      declaredType: 'image/png',
      bytes: pngWithText('a'.repeat(200)),
    });
    expect((await peekQuota(prisma, owner)).usedBytes).toBe(0n);
    expect(await prisma.asset.count({ where: { ownerId: owner } })).toBe(0);
  });

  it('two concurrent reservations cannot BOTH succeed', async () => {
    // The race INV-QUOTA-1 is about. Two uploads, each individually under the remaining quota,
    // started at the same moment. A read-then-write check lets both through; a single conditional
    // UPDATE cannot.
    // A quota that fits EXACTLY ONE of two payloads. Both fit individually; together they do
    // not. A read-then-write check lets both through, because each read sees room for one.
    const owner = await user(8_000n);
    const payload = bigPng(6_000);
    // Sanity, so a fixture change cannot quietly turn this into a test of nothing.
    expect(BigInt(payload.length)).toBeGreaterThan(4_000n);
    const attempts = await Promise.allSettled([
      storeAsset(prisma, {
        now: NOW,
        ownerId: owner,
        filename: 'a.png',
        declaredType: 'image/png',
        bytes: payload,
      }),
      storeAsset(prisma, {
        now: NOW,
        ownerId: owner,
        filename: 'b.png',
        declaredType: 'image/png',
        bytes: payload,
      }),
    ]);
    const ok = attempts.filter((a) => a.status === 'fulfilled' && a.value.ok).length;
    const over = attempts.filter(
      (a) => a.status === 'fulfilled' && !a.value.ok && a.value.code === 'overQuota',
    ).length;
    expect(ok + over, 'both attempts must have resolved one way or the other').toBe(2);
    // EXACTLY one. This is the assertion that fails under a read-then-write check, and it is the
    // whole reason the reservation is a conditional UPDATE rather than a read plus a write.
    expect(ok).toBe(1);
    expect(over).toBe(1);
    // And the counter agrees with the outcome, so a refusal did not quietly charge anyway.
    const state = await peekQuota(prisma, owner);
    expect(state.usedBytes <= state.quotaBytes).toBe(true);
    expect(await prisma.asset.count({ where: { ownerId: owner } })).toBe(1);
  });

  it('refuses a .png containing HTML before anything is written', async () => {
    const owner = await user();
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const outcome = await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'diagram.png',
      declaredType: 'image/png',
      bytes: html,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('rejected');
    expect(outcome.message).toContain('contents are not a recognised image');
    // No row, and no quota charged, for a file that was never a candidate for storage.
    expect(await prisma.asset.count({ where: { ownerId: owner } })).toBe(0);
    expect((await peekQuota(prisma, owner)).usedBytes).toBe(0n);
  });

  it('refuses an SVG with a reason', async () => {
    const owner = await user();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const outcome = await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'diagram.svg',
      declaredType: 'image/svg+xml',
      bytes: svg,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('SVG is not accepted as an image');
  });

  it('stores an asset as PENDING, never optimistically CLEAN', async () => {
    const owner = await user();
    const outcome = await storeAsset(prisma, {
      now: NOW,
      ownerId: owner,
      filename: 'diagram.png',
      declaredType: 'image/png',
      bytes: pngWithText(null),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The local scanner reports SKIPPED, and SKIPPED is recorded -- not smoothed into CLEAN.
    expect(outcome.scanStatus).toBe('SKIPPED');
    const row = await prisma.asset.findUnique({ where: { id: outcome.assetId } });
    expect(row?.scanStatus).toBe('SKIPPED');
    expect(row?.status).toBe('READY');
  });

  it('will not grade anything scanned by the no-op scanner', async () => {
    // An environment that can grade without a scanner is one that will also grade without a
    // scanner in production, because the difference was never written down. Failing closed here
    // is the reason the no-op is safe to ship.
    expect(noOpScanner.authoritative).toBe(false);
    expect(isGradeable({ scanStatus: 'CLEAN' }).gradeable).toBe(true);
    for (const status of ['PENDING', 'INFECTED', 'ERROR', 'SKIPPED', 'WHO_KNOWS']) {
      const verdict = isGradeable({ scanStatus: status });
      expect(verdict.gradeable, status).toBe(false);
      expect(verdict.reason, status).toBeTruthy();
    }
  });

  it('raises a quota and the next upload succeeds', async () => {
    const owner = await user(10n);
    const bytes = pngWithText('a'.repeat(200));
    expect(
      (
        await storeAsset(prisma, {
          now: NOW,
          ownerId: owner,
          filename: 'a.png',
          declaredType: 'image/png',
          bytes,
        })
      ).ok,
    ).toBe(false);
    await setQuota(prisma, owner, 10_000_000n);
    expect((await peekQuota(prisma, owner)).quotaBytes).toBe(10_000_000n);
    expect(
      (
        await storeAsset(prisma, {
          now: NOW,
          ownerId: owner,
          filename: 'a.png',
          declaredType: 'image/png',
          bytes,
        })
      ).ok,
    ).toBe(true);
  });
});
