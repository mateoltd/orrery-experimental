/**
 * The codec registry — the shape `P16-T1` fills in.  (P5-T13)
 *
 * ## WHY A REGISTRY AND NOT A SWITCH
 *
 * Four standards need to leave and two need to come back, and each of them fails differently: a
 * QTI package that drops a question needs a mapping report, a grade passback that runs early needs
 * a refusal, a roster sync that half-applies needs a transaction. A `switch (kind)` would put all
 * six in one function with six ways to forget a step.
 *
 * ## A CODEC MUST DECLARE WHAT IT CARRIES, BEFORE IT RUNS
 *
 * `B13`: "QTI export is a key-exfiltration surface. Every write to this table for kind
 * QTI_ASSESSMENT is an audited event naming the item ids."
 *
 * For the audit to name the item ids, somebody has to HAVE them at the moment the binding is
 * written. So `ExportContext.items` is not optional metadata — the registry refuses to export
 * `QTI_ASSESSMENT` without it. A codec that could not name what it is sending would produce an
 * audit event with nothing in it, and an audit event with nothing in it is a receipt, not a
 * control.
 *
 * ## THE SEALED GRADE IS NOT AN ARGUMENT ANYWHERE IN THIS FILE
 *
 * A codec receives a `ReleasedGrade` and never a `Grade`. `assertGradeIsExportable` is called by
 * the caller; the type here is the second lock, because a caller can cast and an argument type
 * that has no sealed arm cannot be cast into by accident.
 */

import type { ReleasedGrade } from './boundary.js';

export type ExternalKind = 'QTI_ASSESSMENT' | 'ONEROSTER_CLASS' | 'ONEROSTER_USER' | 'LTI_PLATFORM';

export type ExternalDirection = 'IMPORT' | 'EXPORT' | 'BIDIRECTIONAL';

export const EXTERNAL_KINDS: readonly ExternalKind[] = [
  'QTI_ASSESSMENT',
  'ONEROSTER_CLASS',
  'ONEROSTER_USER',
  'LTI_PLATFORM',
];

export const EXTERNAL_DIRECTIONS: readonly ExternalDirection[] = [
  'IMPORT',
  'EXPORT',
  'BIDIRECTIONAL',
];

export const isExternalKind = (value: unknown): value is ExternalKind =>
  typeof value === 'string' && (EXTERNAL_KINDS as readonly string[]).includes(value);

export const isExternalDirection = (value: unknown): value is ExternalDirection =>
  typeof value === 'string' && (EXTERNAL_DIRECTIONS as readonly string[]).includes(value);

/** The `ExternalBinding` row, as the interop package sees it. Prisma's version stays in `@orrery/db`. */
export interface ExternalBinding {
  readonly id: string;
  readonly tenantId: string | null;
  readonly kind: ExternalKind;
  readonly externalId: string;
  readonly localType: string;
  readonly localId: string;
  readonly direction: ExternalDirection;
  readonly lastSyncedAt: string | null;
  readonly lastHash: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * What an export is about to send.  (`B13`)
 *
 * `items` is required for `QTI_ASSESSMENT` and forbidden to be empty. It is the list the audit
 * event names, and an export with an empty one is either exporting nothing or exporting something
 * nobody wrote down.
 */
export interface ExportContext {
  readonly kind: ExternalKind;
  readonly binding: Pick<ExternalBinding, 'externalId' | 'localType' | 'localId' | 'tenantId'>;
  /** Item ids in the payload. Named in the audit event for `QTI_ASSESSMENT`. */
  readonly items: readonly string[];
  /** A grade, only if it has been released. There is no sealed arm in this type. */
  readonly grade?: ReleasedGrade;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What an import can do to a document, so `§2.2`'s "no silent loss" is a return value rather than
 * a promise in a README.
 */
export interface MappingReport {
  readonly imported: readonly string[];
  readonly approximated: readonly { readonly what: string; readonly how: string }[];
  readonly dropped: readonly { readonly what: string; readonly why: string }[];
  readonly ignored: readonly { readonly what: string; readonly why: string }[];
}

export const emptyMappingReport = (): MappingReport => ({
  imported: [],
  approximated: [],
  dropped: [],
  ignored: [],
});

export interface ExportCodec<TPayload> {
  readonly kind: ExternalKind;
  /** The version of OUR mapping, written into `manifest.json` so a peer knows what produced this. */
  readonly mappingVersion: string;
  encode(context: ExportContext): Promise<TPayload>;
  /** What a peer should be able to do with this, and what it cannot. `§2.3`. */
  readonly portable: readonly string[];
  readonly NOTPortable: readonly string[];
}

export interface ImportCodec<TPayload> {
  readonly kind: ExternalKind;
  readonly mappingVersion: string;
  decode(payload: TPayload): Promise<{ readonly draft: unknown; readonly report: MappingReport }>;
}

export class CodecRegistry {
  readonly #exports = new Map<ExternalKind, ExportCodec<unknown>>();
  readonly #imports = new Map<ExternalKind, ImportCodec<unknown>>();

  registerExport<T>(codec: ExportCodec<T>): this {
    if (!isExternalKind(codec.kind)) throw new Error(`UNKNOWN_KIND: ${String(codec.kind)}`);
    if (this.#exports.has(codec.kind)) throw new Error(`DUPLICATE_EXPORT_CODEC: ${codec.kind}`);
    this.#exports.set(codec.kind, codec as ExportCodec<unknown>);
    return this;
  }

  registerImport<T>(codec: ImportCodec<T>): this {
    if (!isExternalKind(codec.kind)) throw new Error(`UNKNOWN_KIND: ${String(codec.kind)}`);
    if (this.#imports.has(codec.kind)) throw new Error(`DUPLICATE_IMPORT_CODEC: ${codec.kind}`);
    this.#imports.set(codec.kind, codec as ImportCodec<unknown>);
    return this;
  }

  exportCodec(kind: ExternalKind): ExportCodec<unknown> | undefined {
    return this.#exports.get(kind);
  }

  importCodec(kind: ExternalKind): ImportCodec<unknown> | undefined {
    return this.#imports.get(kind);
  }

  registered(): readonly ExternalKind[] {
    return [...this.#exports.keys(), ...this.#imports.keys()].filter(
      (kind, i, all) => all.indexOf(kind) === i,
    );
  }
}

/**
 * `B13`'s guard. A `QTI_ASSESSMENT` export must name its items, or there is nothing to audit.
 *
 * The reason this is a function rather than a type is that it fires on the *value*, and a type can
 * only say the field exists. A codec that returns `items: []` type-checks perfectly.
 */
export function assertExportIsAuditable(context: ExportContext): void {
  if (context.kind !== 'QTI_ASSESSMENT') return;
  if (context.items.length === 0) {
    throw new Error(
      'UNNAMEABLE_EXPORT: a QTI_ASSESSMENT export must declare the item ids it carries, because ' +
        'the audit event names them. An empty list means either that nothing is being exported or ' +
        'that something is, and nobody wrote down which.',
    );
  }
  const dupes = context.items.filter((id, i) => context.items.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(
      `DUPLICATE_ITEM_IN_EXPORT: ${[...new Set(dupes)].join(', ')}. A duplicated item id means ` +
        'the pool drew it twice, and the audit event would name it once.',
    );
  }
}

/**
 * The four things that are OURS and do not travel. `§2.3`.
 *
 * This list is in code rather than in the export manifest alone, because a manifest is written by
 * the exporter and read by someone else: a peer who imports our maths quiz gets the questions and
 * the marks, not the exam conditions, and we would rather say that plainly than ship a lossy
 * conversion that pretends otherwise.
 */
export const NON_PORTABLE_FEATURES: readonly string[] = [
  'simulations (exported as an extended-text interaction carrying sim id and version)',
  'integrity policy and evidence',
  'release batching and sealed grades',
  'accommodations',
  'item analysis',
  'attempt-level integrity events',
];
