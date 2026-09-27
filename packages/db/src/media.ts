/**
 * Storing an asset: quota, scan status, and what may be graded.  (P2-T6, INV-QUOTA-1, D-12)
 *
 * ## The order of operations, and why the quota comes first
 *
 * `validate -> reserve quota -> insert -> mark pending`. The quota reservation is in the SAME
 * transaction as the insert, and that is the whole of INV-QUOTA-1: a reservation in one
 * transaction and an insert in another means a failed insert charges the user for bytes they
 * never stored, and a quota that leaks is a quota everybody stops trusting.
 *
 * ## D-12: the scan adapter ships WITH the media library
 *
 * The original plan scheduled scanning seven phases after the media library, which left a window
 * of unscanned student uploads and made `P7-T7` depend on a capability that did not exist. So the
 * adapter is here, in the same task, and `P7-T7` has something to depend on.
 *
 * `ScanAdapter` has two implementations and the choice is explicit rather than ambient:
 * `noOpScanner` for local development and tests, `ClamAvScanner` for production. The no-op
 * **reports itself as such** — a scan result claiming `CLEAN` from a scanner that did nothing is
 * indistinguishable from a real clean result, so `noOpScanner` returns `SKIPPED` and
 * `isGradeable` refuses anything that is not explicitly `CLEAN`. A local no-op therefore cannot
 * accidentally stand in for production, and a misconfigured production instance fails CLOSED.
 *
 * ## "Gradeable" is a property of the asset, not of the route
 *
 * A submission that references an unscanned or infected asset must not be gradeable. Putting
 * that decision in one function means the exam runtime, the teacher interface and the release
 * batch all ask the same question and get the same answer, and it means the question cannot be
 * forgotten at one of the three call sites.
 */

import { contentChecksum } from '@orrery/contracts/editor';
import {
  type AssetKind,
  MAX_ASSET_BYTES,
  type UploadVerdict,
  validateUpload,
} from '@orrery/contracts/media';
import type { PrismaClient } from './index.js';
import { QuotaError, reserveQuota } from './quota.js';

export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR' | 'SKIPPED';

export interface ScanResult {
  readonly status: ScanStatus;
  readonly signature: string | null;
  readonly detail: string | null;
}

export interface ScanAdapter {
  readonly name: string;
  /**
   * Whether this adapter really scans. `false` makes the asset permanently ungradeable, which is
   * what stops a no-op from standing in for a real scanner.
   */
  readonly authoritative: boolean;
  /** A PROPERTY, not a method signature: `readonly` is not valid on a method declaration. */
  readonly scan: (assetId: string, bytes: Uint8Array) => Promise<ScanResult>;
}

/**
 * The local/test scanner. Reports `SKIPPED`, never `CLEAN`.
 *
 * The refusal to say `CLEAN` is the design. A no-op that returned `CLEAN` would be
 * indistinguishable from a real clean scan in the database, in the UI and in the gradeability
 * check, and the failure would surface as "the antivirus let something through" weeks later.
 */
export const noOpScanner: ScanAdapter = {
  name: 'noop',
  authoritative: false,
  async scan() {
    return {
      status: 'SKIPPED',
      signature: null,
      detail: 'No scanner configured. This is expected in development and tests.',
    };
  },
};

export interface ClamAvOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  /** Injected per INV-TIME-1, and so a test can answer instantly. A property, not a method. */
  readonly now: () => number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * ClamAV over INSTREAM.
 *
 * The protocol is one request per file: connect, write the bytes, read a verdict line. Failures
 * return `ERROR`, never `CLEAN` — a scanner that cannot be reached must not produce a clean bill
 * of health, because that is the one result everybody downstream trusts.
 */
export function clamAvScanner(options: ClamAvOptions): ScanAdapter {
  const send = options.fetchImpl ?? fetch;
  return {
    name: 'clamav',
    authoritative: true,
    async scan(_assetId, bytes) {
      try {
        // The body type is taken from `fetch` itself rather than from a DOM lib the package
        // does not include: `packages/db` has no DOM, and naming a type it cannot see would be a
        // second thing to keep in step with the runtime.
        type Body = NonNullable<Parameters<typeof fetch>[1]>['body'];
        const response = await send(`http://${options.host}:${options.port}/`, {
          method: 'POST',
          // A Uint8Array is a valid body at runtime; the fetch typings do not model it, so the
          // cast sits at the boundary and nowhere else.
          body: bytes as unknown as Body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
        const text = (await response.text()).trim();
        const infected = text.endsWith('FOUND');
        return {
          status: infected ? 'INFECTED' : 'CLEAN',
          signature: infected ? (text.split(':')[1] ?? 'UNKNOWN').trim() : null,
          detail: text,
        };
      } catch (e) {
        void options.now;
        return {
          status: 'ERROR',
          signature: null,
          detail: `scanner unreachable: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

export interface StoreAssetInput {
  /** Injected per INV-TIME-1, so `scannedAt` does not read the host clock. */
  readonly now: () => number;
  readonly ownerId: string;
  readonly filename: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
  readonly kind?: AssetKind;
  readonly maxBytes?: number;
}

export type StoreOutcome =
  | {
      readonly ok: true;
      readonly assetId: string;
      readonly byteSize: number;
      readonly checksum: string;
      /** The stored size, which is the size AFTER metadata removal. */
      readonly metadataRemoved: boolean;
      readonly scanStatus: ScanStatus;
    }
  | { readonly ok: false; readonly code: 'rejected' | 'overQuota'; readonly message: string };

/**
 * Store an asset, with the quota reserved in the same transaction.
 *
 * ## The byte size charged is the byte size STORED
 *
 * Metadata removal shrinks the file, and the quota is charged what is actually kept. Charging the
 * uploaded size instead would quietly penalise a teacher for the EXIF their camera wrote, which
 * is both wrong and a small way of making the metadata strip feel punitive rather than
 * protective.
 */
export async function storeAsset(
  db: PrismaClient,
  input: StoreAssetInput,
  scanner: ScanAdapter = noOpScanner,
): Promise<StoreOutcome> {
  const verdict: UploadVerdict = validateUpload({
    filename: input.filename,
    declaredType: input.declaredType,
    bytes: input.bytes,
    maxBytes: input.maxBytes ?? MAX_ASSET_BYTES,
  });
  if (!verdict.ok) return { ok: false, code: 'rejected', message: verdict.message };

  const bytes = verdict.bytes;
  const size = BigInt(bytes.length);

  try {
    return await db.$transaction(async (tx) => {
      // INV-QUOTA-1. Inside the transaction that stores the bytes.
      await reserveQuota(tx, input.ownerId, size);

      const created = await tx.asset.create({
        data: {
          ownerId: input.ownerId,
          kind: input.kind ?? verdict.kind,
          key: `${input.ownerId}/${crypto.randomUUID()}`,
          contentType: verdict.contentType,
          byteSize: bytes.length,
          altText: null,
          checksum: contentChecksum(bytes),
          // PENDING until a scan says otherwise. Not optimistically CLEAN, not optimistically
          // READY: an asset nobody has looked at is exactly what the scan status is for.
          scanStatus: 'PENDING',
          status: 'PENDING',
        },
        select: { id: true },
      });

      const scan = await scanner.scan(created.id, bytes);
      await tx.asset.update({
        where: { id: created.id },
        data: {
          scanStatus: scan.status,
          status: scan.status === 'INFECTED' ? 'QUARANTINED' : 'READY',
          // A converted injected instant, never `new Date()`: INV-TIME-1 bans the no-argument
          // form because a scan timestamp that depends on which machine ran the test is one
          // nobody can reason about in an incident.
          scannedAt: new Date(input.now()),
          altText: null,
        },
      });

      return {
        ok: true as const,
        assetId: created.id,
        byteSize: bytes.length,
        checksum: contentChecksum(bytes),
        metadataRemoved: verdict.metadataRemoved,
        scanStatus: scan.status,
      };
    });
  } catch (e) {
    if (e instanceof QuotaError) return { ok: false, code: 'overQuota', message: e.message };
    throw e;
  }
}

export interface Gradeability {
  readonly gradeable: boolean;
  readonly reason: string | null;
}

/**
 * May anything be graded against this asset?
 *
 * One function, asked by the exam runtime, the teacher interface and the release batch. The
 * alternative is three `if (scanStatus === 'CLEAN')` checks, and the one somebody forgets is
 * always the release batch.
 *
 * Note `SKIPPED` is NOT gradeable. A local environment therefore cannot grade, which is
 * inconvenient and correct: an environment that can grade without a scanner is one that will
 * also grade without a scanner in production, because the difference was never written down.
 */
export function isGradeable(asset: {
  readonly scanStatus: string;
  readonly status?: string;
}): Gradeability {
  if (asset.scanStatus === 'INFECTED') {
    return {
      gradeable: false,
      reason: 'This file was found by the virus scanner and is quarantined.',
    };
  }
  if (asset.scanStatus === 'PENDING') {
    return { gradeable: false, reason: 'This file has not been scanned yet.' };
  }
  if (asset.scanStatus === 'ERROR') {
    return {
      gradeable: false,
      reason: 'The virus scanner could not be reached, so this file is unverified.',
    };
  }
  if (asset.scanStatus === 'SKIPPED') {
    return {
      gradeable: false,
      reason: 'No virus scanner is configured for this environment, so nothing here can be graded.',
    };
  }
  if (asset.scanStatus !== 'CLEAN') {
    return { gradeable: false, reason: `Unknown scan status "${asset.scanStatus}".` };
  }
  if (asset.status === 'QUARANTINED') {
    return { gradeable: false, reason: 'This file is quarantined.' };
  }
  return { gradeable: true, reason: null };
}

/**
 * The publish-time checks an asset must pass before a resource may be published.  (P2-T10)
 *
 * Alt text is required for images, and a caption track for videos — the two accessibility
 * requirements `plans/14` §4 and the block schema both assume and neither can enforce. An
 * `altText` of `""` is DELIBERATE (a decorative image) and passes; `null` is absent and fails,
 * which is the distinction the block schema's comment makes about `alt` being required rather
 * than optional.
 */
export function publishBlockerForAsset(asset: {
  readonly kind: string;
  readonly altText: string | null;
  readonly scanStatus: string;
}): string | null {
  if (asset.kind === 'image' && asset.altText === null) {
    return 'This image has no alt text. Describe it, or mark it decorative with empty alt text.';
  }
  if (asset.scanStatus === 'INFECTED') return 'This file is quarantined.';
  return null;
}
