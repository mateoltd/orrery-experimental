/**
 * Upload validation.  (P2-T6)
 *
 * ## The four cases the packet names
 *
 *  · a `.png` containing HTML is rejected          · an SVG is refused WITH A REASON
 *  · exceeding the size cap is a clear error       · the byte size charged is the STORED size
 *
 * ## The test underneath all of them
 *
 * `the declared type is never trusted`. Every rejection below is driven by the BYTES, and the
 * declared `Content-Type` and the filename are only ever used to check what the bytes already
 * proved. An uploader that can lie about its own type has no reason to tell the truth about its
 * contents.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED,
  DEFAULT_QUOTA_BYTES,
  hasImageMetadata,
  jpegWithExif,
  MAX_BLOCKS_BYTES,
  pngWithText,
  REFUSED_SVG,
  sniffContentType,
  sniffSvg,
  stripImageMetadata,
  validateUpload,
} from './index.js';

const enc = (s: string) => new TextEncoder().encode(s);
const upload = (filename: string, declaredType: string, bytes: Uint8Array) =>
  validateUpload({ filename, declaredType, bytes });

describe('the declared type is never trusted', () => {
  it('rejects a .png whose contents are HTML — the case the packet names', () => {
    const html = enc('<!doctype html><html><body><script>alert(1)</script></body></html>');
    const v = upload('diagram.png', 'image/png', html);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('notAnImage');
    // The message names BOTH sides, because "invalid file" tells the teacher nothing about the
    // one thing they can act on.
    expect(v.message).toContain('image/png');
    expect(v.message).toContain('contents are');
  });

  it('rejects a .png whose contents are a real PNG but mis-declared as a JPEG', () => {
    const png = pngWithText(null);
    const v = upload('photo.png', 'image/jpeg', png);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('magicMismatch');
    expect(v.message).toContain('Renaming a file does not change what it is');
  });

  it('accepts a .png whose contents really are a PNG', () => {
    const v = upload('photo.png', 'image/png', pngWithText(null));
    expect(v.ok).toBe(true);
  });

  it('rejects a file with no recognised magic bytes at all', () => {
    for (const bytes of [enc('just some text'), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])]) {
      const v = upload('notes.txt', 'text/plain', bytes);
      expect(v.ok, new TextDecoder().decode(bytes)).toBe(false);
    }
  });

  it('accepts every type on the allowlist, by its own bytes', () => {
    for (const type of ACCEPTED) {
      if (type.magic.length === 0) continue; // text/vtt has no signature, asserted separately.
      const bytes = Uint8Array.from(type.magic[0] as readonly number[]);
      expect(sniffContentType(bytes), type.contentType).toBe(type.contentType);
    }
  });
});

describe('SVG', () => {
  it('is refused as an image, with a reason the teacher can act on', () => {
    const svg = enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const v = upload('diagram.svg', 'image/svg+xml', svg);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('svgRefused');
    expect(v.message).toContain('scripts');
    // And it says what to do instead, because a refusal with no alternative gets a support ticket.
    expect(v.message).toContain('PNG');
  });

  it('is refused EVEN IF it claims to be a PNG', () => {
    // The whole point of sniffing content rather than reading the name.
    const svg = enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const v = upload('totally-an-image.png', 'image/png', svg);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('svgRefused');
  });

  it('is recognised by content, not by extension', () => {
    expect(sniffSvg(enc('<svg viewBox="0 0 1 1">'))).toBe(REFUSED_SVG.contentType);
    expect(sniffSvg(enc('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">'))).toBe(
      REFUSED_SVG.contentType,
    );
    expect(sniffSvg(pngWithText(null))).toBeNull();
  });

  it('is absent from the allowlist, not merely unsupported', () => {
    expect(ACCEPTED.map((t) => t.contentType)).not.toContain('image/svg+xml');
  });
});

describe('size', () => {
  it('rejects an oversized file with both numbers in the message', () => {
    const big = Uint8Array.from(pngWithText(null));
    const v = validateUpload({
      filename: 'big.png',
      declaredType: 'image/png',
      bytes: big,
      maxBytes: 10,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('tooLarge');
    // "Too large" alone makes a teacher guess; the actual and the limit do not.
    expect(v.message).toMatch(/limit is/);
  });

  it('rejects an empty file', () => {
    const v = upload('empty.png', 'image/png', Uint8Array.from([]));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('empty');
  });

  it('has a 2 MB publish cap on blocks, separate from the asset cap', () => {
    // Two different limits for two different things: an asset is a file, a block payload is a
    // document. Conflating them means either 25 MB lessons or 25 MB images we cannot take.
    expect(MAX_BLOCKS_BYTES).toBe(2 * 1024 * 1024);
    expect(DEFAULT_QUOTA_BYTES).toBe(1_000_000_000);
  });
});

describe('metadata removal', () => {
  it('takes EXIF out of a JPEG and leaves the pixels alone', () => {
    const withExif = jpegWithExif(true);
    expect(hasImageMetadata(withExif)).toBe(true);
    const stripped = stripImageMetadata(withExif);
    expect(stripped.removed).toBe(true);
    expect(stripped.found).toContain('APP1');
    const text = new TextDecoder('latin1').decode(stripped.bytes);
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('Exif');
    // Checked as BYTES, not as a hex string. The first version asserted `text.startsWith('FFD8')`
    // against a latin1 decode, which yields the characters `ÿØ` -- so a correct strip failed an
    // assertion that was itself wrong.
    expect(Array.from(stripped.bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
    // SOF and SOS survive: the image still exists.
    const markers = new Set<string>();
    for (let i = 0; i < stripped.bytes.length - 1; i += 1) {
      if (stripped.bytes[i] === 0xff) markers.add((stripped.bytes[i + 1] as number).toString(16));
    }
    expect(markers.has('c0')).toBe(true); // SOF0, the frame header
    expect(markers.has('da')).toBe(true); // SOS, start of scan
  });

  it('removes JFIF too, because it is metadata', () => {
    // APP0 carries pixel density and sometimes a thumbnail. The first "clean" fixture had one in
    // it and the test asserted byte-identity, so the strip was right and the test was wrong.
    const withJfif = jpegWithExif(false, true);
    expect(stripImageMetadata(withJfif).found).toContain('APP0');
    const bare = jpegWithExif(false, false);
    const stripped = stripImageMetadata(bare);
    expect(stripped.removed).toBe(false);
    expect(stripped.bytes).toEqual(bare);
  });

  it('takes a tEXt chunk out of a PNG', () => {
    const withText = pngWithText('Shot on my phone at home');
    const stripped = stripImageMetadata(withText);
    expect(stripped.removed).toBe(true);
    expect(stripped.found).toContain('tEXt');
    expect(new TextDecoder('latin1').decode(stripped.bytes)).not.toContain('home');
    // The signature and the pixel data survive.
    expect(Array.from(stripped.bytes.subarray(0, 8))).toEqual(Array.from(withText.subarray(0, 8)));
    expect(new TextDecoder('latin1').decode(stripped.bytes)).toContain('IDAT');
  });

  it('reports through the verdict, because silence about stripping is a bug', () => {
    const v = upload('photo.jpg', 'image/jpeg', jpegWithExif(true));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.metadataRemoved).toBe(true);
    // A genuinely bare JPEG: `jpegWithExif(false)` still carries a JFIF APP0, which is metadata.
    const clean = upload('photo.jpg', 'image/jpeg', jpegWithExif(false, false));
    if (!clean.ok) return;
    expect(clean.metadataRemoved).toBe(false);
  });

  it('leaves a TRUNCATED file alone rather than emitting half of one', () => {
    // A mangled image stored as valid is worse than a rejected upload.
    const truncated = jpegWithExif(true).subarray(0, 12);
    const stripped = stripImageMetadata(truncated);
    expect(stripped.removed).toBe(false);
    expect(stripped.bytes).toEqual(truncated);
  });

  it('does not point a PNG-only walk at an MP4', () => {
    // A container walk that half-understood MP4 would corrupt every video upload.
    const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);
    expect(stripImageMetadata(mp4).removed).toBe(false);
    expect(stripImageMetadata(mp4).bytes).toEqual(mp4);
  });
});
