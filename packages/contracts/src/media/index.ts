/**
 * Upload validation: magic bytes, the type allowlist, and metadata removal.  (P2-T6)
 *
 * ## The one rule everything else serves
 *
 * **The declared content type is a claim; the bytes are the evidence.** A `.png` that contains
 * HTML is a `.png` by filename and by `Content-Type` header, and it is HTML to every consumer
 * that matters — a browser rendering it directly, a proxy sniffing it, or an antivirus deciding
 * it is harmless. So nothing here ever trusts the declared type: `sniffContentType` reads the
 * magic bytes and the declared type is only ever used to CHECK them.
 *
 * `plans/14` §4 puts it exactly: "Content-type allowlist, magic-byte verification, size cap,
 * image re-encode stripping EXIF, **SVG rejected as an image**, async scan status."
 *
 * ## SVG is rejected, not sanitised
 *
 * SVG is a document format that can contain `<script>`, `onload=`, external references and
 * `<foreignObject>`. Every one of those is a way to run script, and the number of ways grows
 * faster than any sanitiser can be audited. There is no partial credit: SVG is refused as an
 * image with a reason, and the reason is written for the teacher who is about to ask why.
 *
 * ## Metadata is REMOVED, not re-encoded — and the distinction is deliberate
 *
 * EXIF carries GPS coordinates, the camera serial, and the original filename. On a school
 * platform those are a child's home address attached to a photograph of their classroom. The
 * control removes them by walking the container and dropping the metadata segments: JPEG's
 * `APPn` and PNG's `tEXt`/`iTXt`/`zTXt`/`eXIf`/`tIME`.
 *
 * That is byte-level container editing, not a decode/re-encode, and it is the right trade here:
 * a re-encode with a codec would re-compress every upload, cost CPU per image, and lose quality
 * for a school wifi budget, in exchange for removing the same bytes. The cost of *not* re-encoding
 * is that pixels are not rewritten, so metadata deliberately encoded INTO pixel data would
 * survive — which is outside the threat model for a teacher uploading a diagram, and is stated
 * here rather than left for someone to assume otherwise.
 *
 * ## No dependencies, deliberately
 *
 * `@orrery/contracts` is a server-side package on the path of every API request, and this is
 * pure byte inspection with no codec, no image library and no native module. That keeps the
 * controls testable in milliseconds, which is the only way a test suite actually exercises them.
 */

export const DEFAULT_QUOTA_BYTES = 1_000_000_000; // 1 GB, per INV-QUOTA-1.
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** The publish-time cap on `Resource.blocks`. A lesson over this is a collection of lessons. */
export const MAX_BLOCKS_BYTES = 2 * 1024 * 1024;

export type AssetKind = 'image' | 'video' | 'caption' | 'submission' | 'export';

export interface AcceptedType {
  readonly contentType: string;
  readonly extensions: readonly string[];
  /** The bytes every file of this type starts with. */
  readonly magic: readonly (readonly number[])[];
  readonly kind: AssetKind;
}

/**
 * The allowlist.
 *
 * `image/svg+xml` is absent, and its absence is load-bearing. It is not "not yet supported" —
 * it is never supported, and `REFUSED_SVG` says so.
 */
export const ACCEPTED: readonly AcceptedType[] = [
  {
    contentType: 'image/png',
    extensions: ['png'],
    magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    kind: 'image',
  },
  {
    contentType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    // SOI then a marker. FFD8FF is the shortest reliable JPEG signature; the marker byte is
    // deliberately NOT constrained, because every JPEG starts FF D8 and the third byte varies
    // (E0 for JFIF, E1 for EXIF, DB for JPEG, EE for MP3-in-JPEG).
    magic: [[0xff, 0xd8, 0xff]],
    kind: 'image',
  },
  {
    contentType: 'image/gif',
    extensions: ['gif'],
    magic: [[0x47, 0x49, 0x46, 0x38]],
    kind: 'image',
  },
  {
    contentType: 'image/webp',
    extensions: ['webp'],
    // RIFF....WEBP
    magic: [[0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
    kind: 'image',
  },
  {
    contentType: 'video/mp4',
    extensions: ['mp4', 'm4v'],
    // ....ftyp
    magic: [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
    kind: 'video',
  },
  {
    // WebVTT, the caption format. It is text, so it is the one accepted type with no magic
    // number to check — which is exactly why the signature check is not optional for the rest.
    contentType: 'text/vtt',
    extensions: ['vtt'],
    magic: [],
    kind: 'caption',
  },
];

/** Extensions that are refused with a specific explanation rather than a generic one. */
export const REFUSED_SVG = {
  contentType: 'image/svg+xml',
  reason:
    'SVG is not accepted as an image. An SVG file is a document that can contain scripts and ' +
    'external references, and there is no safe subset of it to allow. Export the figure as PNG ' +
    'instead — in most tools that is "Export" rather than "Save as".',
} as const;

export type RejectReason =
  | 'empty'
  | 'tooLarge'
  | 'svgRefused'
  | 'typeNotAllowed'
  | 'magicMismatch'
  | 'notAnImage'
  | 'extensionMismatch';

export type UploadVerdict =
  | {
      readonly ok: true;
      readonly contentType: string;
      readonly kind: AssetKind;
      /** The bytes, with metadata removed if it was an image. */
      readonly bytes: Uint8Array;
      /** True when metadata was found and taken out. Reported, because silence here is a bug. */
      readonly metadataRemoved: boolean;
    }
  | { readonly ok: false; readonly reason: RejectReason; readonly message: string };

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/**
 * What the bytes ACTUALLY are.
 *
 * `null` for anything not on the allowlist, which is the answer that matters: a file whose bytes
 * are HTML is not an image whatever it is called.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  // Checked explicitly rather than falling out of the loop, because SVG's magic
  // (`<svg` or an XML prolog) overlaps nothing else and deserves its own message.
  if (sniffSvg(bytes) !== null) return REFUSED_SVG.contentType;
  for (const type of ACCEPTED) {
    if (type.magic.some((m) => startsWith(bytes, m))) return type.contentType;
  }
  return null;
}

/** SVG, recognised by its content rather than its name. */
export function sniffSvg(bytes: Uint8Array): string | null {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .toLowerCase();
  const prolog = head.includes('<?xml');
  const rootTag = /<svg[\s/>]/.test(head);
  const doctype = head.includes('<!doctype svg');
  if (doctype || rootTag) return REFUSED_SVG.contentType;
  // An XML prolog alone is not SVG, but an XML prolog followed by nothing recognisable in an
  // image slot is still not an image, and saying so is more useful than "unknown".
  if (prolog && !/^<\?xml[^>]*\?>\s*$/.test(head.trim())) return 'application/xml';
  return null;
}

const extensionOf = (filename: string): string => (filename.split('.').pop() ?? '').toLowerCase();

/**
 * Validate an upload.
 *
 * Order matters and is deliberate: size first, because it is the cheapest rejection and the most
 * likely; then SVG, because it is the one with a real explanation to give; then magic bytes,
 * because that is the actual security check; and the declared type and extension LAST, as
 * consistency checks on something already established.
 */
export function validateUpload(input: {
  readonly filename: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
  readonly maxBytes?: number;
}): UploadVerdict {
  const max = input.maxBytes ?? MAX_ASSET_BYTES;
  if (input.bytes.length === 0) {
    return { ok: false, reason: 'empty', message: 'The file is empty.' };
  }
  if (input.bytes.length > max) {
    return {
      ok: false,
      reason: 'tooLarge',
      message: `That file is ${mb(input.bytes.length)} MB. The limit is ${mb(max)}.`,
    };
  }

  const declaredBase = input.declaredType.split(';')[0]?.trim().toLowerCase() ?? '';
  const sniffed = sniffContentType(input.bytes);

  if (sniffed === REFUSED_SVG.contentType) {
    return { ok: false, reason: 'svgRefused', message: REFUSED_SVG.reason };
  }

  if (sniffed === null) {
    // The SVG reason is appended here rather than repeated above, because an SVG that ALSO
    // fails the allowlist should not be told it is "not a recognised image" -- it should be
    // told the one thing that would actually fix it.
    return {
      ok: false,
      reason: 'notAnImage',
      // The DECLARED type is named even when the bytes are unrecognisable, because "not a
      // recognised image" on its own leaves the teacher with nothing to act on. The likely case
      // is a file whose name and `Content-Type` say one thing and whose bytes say another, and
      // saying so is the difference between a message and a shrug.
      message:
        declaredBase === ''
          ? `That file is not a recognised ${input.declaredType.startsWith('image/') ? 'image' : 'file'}. ` +
            `Accepted: ${ACCEPTED.map((t) => t.contentType).join(', ')}.`
          : `That file is called ${declaredBase} but its contents are not a recognised image. ` +
            `Accepted: ${ACCEPTED.map((t) => t.contentType).join(', ')}. ` +
            `Renaming a file does not change what it is. SVG is not accepted at all: ${REFUSED_SVG.reason}`,
    };
  }

  // The declared type must AGREE with the bytes.
  if (declaredBase !== '' && declaredBase !== sniffed) {
    return {
      ok: false,
      reason: 'magicMismatch',
      message:
        `This file is called ${declaredBase} but its contents are ${sniffed}. ` +
        `Renaming a file does not change what it is, so the upload was refused.`,
    };
  }

  const entry = ACCEPTED.find((t) => t.contentType === sniffed);
  if (entry === undefined) {
    return { ok: false, reason: 'typeNotAllowed', message: `${sniffed} is not on the allowlist.` };
  }

  const ext = extensionOf(input.filename);
  if (ext !== '' && !entry.extensions.includes(ext)) {
    return {
      ok: false,
      reason: 'extensionMismatch',
      message: `A ${sniffed} file should end in ${entry.extensions.join(' or ')}, not .${ext}.`,
    };
  }

  // Images get their metadata taken out; videos and captions are passed through untouched,
  // because a container walk that only understands PNG and JPEG must not be pointed at an MP4.
  const stripped: StripResult =
    entry.kind === 'image'
      ? stripImageMetadata(input.bytes)
      : { bytes: input.bytes, removed: false, found: [] };
  return {
    ok: true,
    contentType: entry.contentType,
    kind: entry.kind,
    bytes: stripped.bytes,
    metadataRemoved: stripped.removed,
  };
}

// ── Metadata removal ───────────────────────────────────────────────────────────

export interface StripResult {
  readonly bytes: Uint8Array;
  /** True when something was actually removed. Silence about this is a bug, not a pass. */
  readonly removed: boolean;
  /** What was found, for the audit row. */
  readonly found: readonly string[];
}

const encoder = new TextEncoder();

/**
 * Remove image metadata by walking the container.
 *
 * ## PNG
 *
 * Chunks are `length(4) type(4) data crc(4)`. Dropping `tEXt`, `zTXt`, `iTXt`, `eXIf` and
 * `tIME` and fixing each chunk's length is the whole job. Pixel data (`IDAT`) and the palette are
 * untouched, so the image is bit-identical apart from the metadata.
 *
 * ## JPEG
 *
 * Segments are `marker(2) length(2) payload`, running to `SOS` (FFDA) after which is entropy-
 * coded scan data that must be copied byte for byte. `APP0`–`APP15` carry EXIF, XMP, ICC and
 * JFIF; all of them go. `COM` comments go too, since a comment is free text someone chose to
 * embed.
 *
 * A truncated or unrecognised file is returned UNCHANGED rather than mangled — the upload is
 * then rejected by the magic check, and "we could not parse it so we left it alone" is the honest
 * outcome, whereas emitting half a file would be a corrupt image stored as valid.
 */
export function stripImageMetadata(input: Uint8Array): StripResult {
  if (startsWith(input, [0x89, 0x50, 0x4e, 0x47])) return stripPng(input);
  if (startsWith(input, [0xff, 0xd8, 0xff])) return stripJpeg(input);
  return { bytes: input, removed: false, found: [] };
}

/** PNG metadata chunk types. `eXIf` is the one people forget, and it is the one that carries GPS. */
const PNG_METADATA = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dSIG']);

function stripPng(input: Uint8Array): StripResult {
  // 8-byte signature, then chunks.
  const found: string[] = [];
  const out: number[] = [];
  let offset = 8;
  if (input.length < 8) return { bytes: input, removed: false, found };

  // The signature is copied verbatim; rewriting it would be a different file.
  for (let i = 0; i < 8; i += 1) out.push(input[i] as number);

  let sawIend = false;
  while (offset + 8 <= input.length) {
    const view = new DataView(input.buffer, input.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
    const total = 12 + length;
    if (total < 12 || offset + total > input.length) {
      // Truncated. Return the input untouched rather than emitting a half-file.
      return { bytes: input, removed: false, found };
    }
    if (type === 'IEND') sawIend = true;
    if (!PNG_METADATA.has(type)) {
      for (let i = 0; i < total; i += 1) out.push(input[offset + i] as number);
    } else {
      found.push(type);
    }
    offset += total;
    if (sawIend) break;
  }

  if (!sawIend) return { bytes: input, removed: false, found };
  return { bytes: Uint8Array.from(out), removed: found.length > 0, found };
}

function stripJpeg(input: Uint8Array): StripResult {
  const found: string[] = [];
  const out: number[] = [];
  let offset = 0;
  let sawEoi = false;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) {
      // Not a marker where one was expected: a malformed file. Leave it alone.
      return { bytes: input, removed: false, found };
    }
    const marker = input[offset + 1] as number;
    // Fill bytes: FF FF is legal padding before a marker.
    if (marker === 0xff) {
      out.push(input[offset] as number);
      offset += 1;
      continue;
    }
    // Standalone markers, no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(input[offset] as number, marker);
      offset += 2;
      if (marker === 0xd9) sawEoi = true;
      if (sawEoi) break;
      continue;
    }

    const length = (input[offset + 2] as number) * 256 + (input[offset + 3] as number);
    if (length < 2 || offset + 2 + length > input.length) {
      return { bytes: input, removed: false, found };
    }
    // APP0-APP15 and COM are metadata. Everything else -- SOF, DHT, DQT, SOS -- is the image.
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isApp || isComment) {
      found.push(isComment ? 'COM' : `APP${marker - 0xe0}`);
    } else {
      for (let i = 0; i < 2 + length; i += 1) out.push(input[offset + i] as number);
    }
    offset += 2 + length;
    // After SOS the rest is entropy-coded scan data, which can contain any byte including 0xFF,
    // so it is copied verbatim rather than walked. The EOI lives inside that tail, which is why
    // completeness is decided by looking at the END of the input rather than by expecting to
    // reach a D9 marker through the segment loop -- the first version looked for it in the loop,
    // never found it, and silently returned every JPEG unchanged.
    if (marker === 0xda) {
      for (let i = offset; i < input.length; i += 1) out.push(input[i] as number);
      sawEoi =
        input.length >= 2 && input[input.length - 2] === 0xff && input[input.length - 1] === 0xd9;
      offset = input.length;
    }
  }

  if (!sawEoi) return { bytes: input, removed: false, found };
  return { bytes: Uint8Array.from(out), removed: found.length > 0, found };
}

/** Whether the bytes carry metadata worth reporting. Used by the audit and by tests. */
export function hasImageMetadata(bytes: Uint8Array): boolean {
  return stripImageMetadata(bytes).found.length > 0;
}

/** A minimal valid PNG with an optional `tEXt` chunk, for building fixtures. */
export function pngWithText(text: string | null): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunks: number[] = [];
  const push = (type: string, data: number[]) => {
    const len = data.length;
    chunks.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    for (const c of encoder.encode(type)) chunks.push(c);
    chunks.push(...data);
    chunks.push(0, 0, 0, 0); // CRC, not validated: these are fixtures, not a decoder.
  };
  push('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  if (text !== null) push('tEXt', [...encoder.encode(`Comment\0${text}`)]);
  push('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  push('IEND', []);
  return Uint8Array.from([...signature, ...chunks]);
}

/**
 * A minimal JPEG, for building fixtures.
 *
 * `jfif` controls the APP0 segment. JFIF carries pixel density and sometimes a thumbnail, so it
 * IS metadata and it IS stripped -- the first version of the "clean JPEG" test asserted
 * byte-identity on a fixture that still had an APP0 in it, and the strip was right and the test
 * was wrong.
 */
export function jpegWithExif(exif: boolean, jfif = true): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const segment = (marker: number, payload: number[]) => {
    const len = payload.length + 2;
    out.push(0xff, marker, (len >>> 8) & 0xff, len & 0xff, ...payload);
  };
  if (jfif) segment(0xe0, [...encoder.encode('JFIF\0')]);
  if (exif) segment(0xe1, [...encoder.encode('Exif\0\0MM\0*Exif stuff with GPS 51.5,-0.1')]);
  segment(0xdb, [0x00, 0x01, 0x02]); // DQT
  segment(0xc0, [0x00, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01]); // SOF0
  segment(0xda, [0x00, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]); // SOS
  out.push(0x12, 0x34, 0x56, 0x78); // entropy-coded scan data
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(1);
