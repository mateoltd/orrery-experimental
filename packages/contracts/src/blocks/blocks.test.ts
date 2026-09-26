/**
 * The block schema's tests.  (P2-T1)
 *
 * The two properties that are the POINT of this file, as opposed to schema coverage:
 *
 *   1. **No HTML can enter the content layer.** Every text field is tested with an XSS payload
 *      and asserted to be accepted AS TEXT — because the correct behaviour is that the payload
 *      is a perfectly good string. The security comes from the renderer emitting only what it
 *      generates, and this file proves the input side cannot smuggle markup past the schema.
 *   2. **Validation errors carry FIELD PATHS.** A boolean tells a developer nothing about
 *      which of 2,000 blocks is wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES,
  type Block,
  blockSchema,
  CURRENT_SCHEMA_VERSION,
  documentSchema,
  validateBlock,
  validateDocument,
} from './index.js';
import { allFrameOrigins, frameSrcFor, PROVIDER_IDS, providerFor } from './providers.js';

const id = (n = 1): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ASSET = id(900);
const SNAPSHOT = id(901);

const run = (text: string) => [{ text }];

describe('the registry', () => {
  it('has exactly 16 types, and adding a 17th without a renderer fails here', () => {
    // `plans/05` §2 lists 16. A 17th needs a renderer, an authoring node, a diff case and a
    // migration step, and this assertion is what makes the omission loud.
    expect(BLOCK_TYPES).toHaveLength(16);
  });

  it('every type in the list is accepted by the union', () => {
    for (const type of BLOCK_TYPES) {
      const result = blockSchema.safeParse({ type, id: id() });
      // Either it parses, or it fails on a REQUIRED field — never with "no such discriminator".
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.code === 'invalid_union_discriminator'),
          `type=${type} is not a member of the discriminated union`,
        ).toBe(false);
      }
    }
  });

  it('the union discriminates on `type`, so a bad type names the field', () => {
    const r = validateBlock({ type: 'script', id: id(), content: run('hi') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('type');
  });
});

describe('SECURITY: HTML cannot enter the content layer', () => {
  const XSS = '<script>alert(1)</script>';
  const IMG_ONERROR = '<img src=x onerror=alert(1)>';
  const JS_HREF = 'javascript:alert(1)';

  it('a paragraph accepts a script tag AS TEXT, which is the correct behaviour', () => {
    // The security is NOT here — it is in the renderer emitting only what it generates. What
    // this test proves is that the schema does not pretend to be a sanitiser: the payload is a
    // valid string, and the renderer is where it must be escaped.
    const r = validateBlock({ type: 'paragraph', id: id(), content: run(XSS) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.type === 'paragraph' && r.block.content[0]?.text).toBe(XSS);
  });

  it('an equation accepts a script tag in the LaTeX as text', () => {
    const r = validateBlock({ type: 'equation', id: id(), latex: XSS, display: 'block' });
    expect(r.ok).toBe(true);
  });

  it('a link href is bounded but NOT filtered — and the comment says who filters it', () => {
    // A `javascript:` href must be REJECTED by the renderer, and pretending to do it here with
    // a regex is the sanitiser-drift the plan rejects. What the schema does is bound the length
    // so a megabyte-long href is not stored.
    const r = validateBlock({
      type: 'paragraph',
      id: id(),
      content: [{ text: 'click', href: JS_HREF }],
    });
    expect(r.ok).toBe(true);

    const long = validateBlock({
      type: 'paragraph',
      id: id(),
      content: [{ text: 'x', href: `https://e.com/${'a'.repeat(3_000)}` }],
    });
    expect(long.ok).toBe(false);
  });

  it('an image alt can contain markup, because alt is text and gets escaped', () => {
    const r = validateBlock({ type: 'image', id: id(), assetId: ASSET, alt: IMG_ONERROR });
    expect(r.ok).toBe(true);
  });

  it('an unknown field is REJECTED, not stripped', () => {
    // Stripping is silent data loss: a document from a newer version loses fields when read by
    // an older one, and the first symptom is content disappearing with no error.
    const r = validateBlock({
      type: 'paragraph',
      id: id(),
      content: run('hi'),
      dangerouslySetInnerHtml: { __html: XSS },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'dangerouslySetInnerHtml')).toBe(true);
  });
});

describe('a11y requirements encoded in the schema, not in a review comment', () => {
  it('image alt is REQUIRED', () => {
    const r = validateBlock({ type: 'image', id: id(), assetId: ASSET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('alt');
  });

  it('but an EMPTY alt is allowed, because "decorative" is a decision a human makes', () => {
    // The renderer emits `alt=""` plus `aria-hidden` for it. What is not allowed is ABSENT,
    // which is how images end up with a filename announced to a screen reader.
    expect(validateBlock({ type: 'image', id: id(), assetId: ASSET, alt: '' }).ok).toBe(true);
  });

  it('table caption is REQUIRED and non-empty', () => {
    expect(validateBlock({ type: 'table', id: id(), header: ['a'], rows: [] }).ok).toBe(false);
    expect(
      validateBlock({ type: 'table', id: id(), caption: '', header: ['a'], rows: [] }).ok,
    ).toBe(false);
  });

  it('a table row with the wrong number of cells is rejected, with a path', () => {
    const r = validateBlock({
      type: 'table',
      id: id(),
      caption: 'Results',
      header: ['a', 'b'],
      rows: [['only one']],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('rows');
  });

  it('alignments must match the header length', () => {
    const r = validateBlock({
      type: 'table',
      id: id(),
      caption: 'c',
      header: ['a', 'b'],
      rows: [],
      alignments: ['left'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('alignments');
  });

  it('a heading level outside 1..4 is rejected', () => {
    // h5/h6 are not in the document outline this product uses, and allowing them would let an
    // author create a heading level the stylesheet does not style.
    expect(validateBlock({ type: 'heading', id: id(), level: 5, content: run('x') }).ok).toBe(
      false,
    );
    expect(validateBlock({ type: 'heading', id: id(), level: 0, content: run('x') }).ok).toBe(
      false,
    );
  });
});

describe('grading integrity', () => {
  it('a GRADED simulation must use a FIXED seed', () => {
    // Two students getting different questions from the same "same" exam is not a nuisance, it
    // is a fairness failure, and it is silent.
    const r = validateBlock({
      type: 'embedSimulation',
      id: id(),
      simId: 'orbit',
      simVersion: '2',
      mode: 'graded',
      seedPolicy: 'PER_STUDENT',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('seedPolicy');
    expect(
      validateBlock({
        type: 'embedSimulation',
        id: id(),
        simId: 'orbit',
        simVersion: '2',
        mode: 'graded',
        seedPolicy: 'FIXED',
      }).ok,
    ).toBe(true);
  });

  it('explore and practice may use per-student seeds', () => {
    for (const mode of ['explore', 'practice'] as const) {
      expect(
        validateBlock({
          type: 'embedSimulation',
          id: id(),
          simId: 'orbit',
          simVersion: '2',
          mode,
          seedPolicy: 'PER_STUDENT',
        }).ok,
        mode,
      ).toBe(true);
    }
  });

  it('a simVersion is PINNED, and required', () => {
    // A floating version changes the behaviour of a lesson that has already been taught.
    expect(
      validateBlock({
        type: 'embedSimulation',
        id: id(),
        simId: 'orbit',
        mode: 'explore',
        seedPolicy: 'FIXED',
      }).ok,
    ).toBe(false);
  });

  it('a practiceCheck carries a SNAPSHOT with its own id, not a reference', () => {
    const r = validateBlock({
      type: 'practiceCheck',
      id: id(),
      feedbackPolicy: 'immediate',
      question: {
        snapshotId: SNAPSHOT,
        stem: run('2+2?'),
        choices: [run('3'), run('4')],
        correctChoiceIndex: 1,
      },
    });
    expect(r.ok).toBe(true);
  });

  it('a correctChoiceIndex outside the choices is rejected, with a path', () => {
    const r = validateBlock({
      type: 'practiceCheck',
      id: id(),
      feedbackPolicy: 'immediate',
      question: {
        snapshotId: SNAPSHOT,
        stem: run('2+2?'),
        choices: [run('3'), run('4')],
        correctChoiceIndex: 5,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('question.correctChoiceIndex');
  });

  it('a choice list needs at least two entries', () => {
    const r = validateBlock({
      type: 'practiceCheck',
      id: id(),
      feedbackPolicy: 'immediate',
      question: {
        snapshotId: SNAPSHOT,
        stem: run('?'),
        choices: [run('only')],
        correctChoiceIndex: 0,
      },
    });
    expect(r.ok).toBe(false);
  });
});

describe('embedExternal is an allowlist, and has no URL field', () => {
  it('a block with a url is REJECTED — the field does not exist', () => {
    const r = validateBlock({
      type: 'embedExternal',
      id: id(),
      provider: 'youtube',
      providerId: 'abc',
      title: 't',
      url: 'https://evil.example',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('url');
  });

  it('an unknown provider is rejected', () => {
    const r = validateBlock({
      type: 'embedExternal',
      id: id(),
      provider: 'evil',
      providerId: 'abc',
      title: 't',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('provider');
  });

  it('a providerId containing a URL is rejected, because it is built INTO a URL', () => {
    // The identifier is interpolated into a template, so it must be an identifier and not a
    // path. `encodeURIComponent` alone would allow `//evil.example` to escape the origin.
    for (const bad of ['abc/../../evil', 'a?x=1', 'a#frag', 'a b']) {
      const r = validateBlock({
        type: 'embedExternal',
        id: id(),
        provider: 'youtube',
        providerId: bad,
        title: 't',
      });
      expect(r.ok, `providerId=${bad}`).toBe(false);
    }
  });

  it('every provider builds a URL on a fixed origin, and nothing else is reachable', () => {
    for (const providerId of PROVIDER_IDS) {
      const p = providerFor(providerId);
      expect(p, providerId).not.toBeNull();
      if (!p) continue;
      const url = new URL(p.template('abc123'));
      expect(url.protocol, providerId).toBe('https:');
      expect(p.frameOrigins, `${providerId} frame-src must include its own origin`).toContain(
        url.origin,
      );
    }
  });

  it('the complete reachable set of frame origins is enumerable and small', () => {
    // The point of an allowlist: the reachable origins can be READ rather than inferred.
    const origins = allFrameOrigins();
    expect(origins.length).toBeGreaterThan(0);
    expect(new Set(origins).size).toBe(origins.length);
    for (const o of origins) expect(new URL(o).protocol, o).toBe('https:');
  });

  it("a provider's frame-src names exactly its own origins — a typo is a hole", () => {
    // The property is per-provider, not global: each entry's CSP is its own origin list, so a
    // copy-paste that leaves Vimeo's origin on the YouTube entry is visible here.
    for (const providerId of PROVIDER_IDS) {
      const p = providerFor(providerId);
      if (!p) continue;
      const expected = p.frameOrigins.join(' ');
      expect(frameSrcFor(p), providerId).toBe(expected);
      for (const origin of allFrameOrigins()) {
        if (!p.frameOrigins.includes(origin)) {
          expect(frameSrcFor(p), `${providerId} must not permit ${origin}`).not.toContain(origin);
        }
      }
    }
  });

  it('the YouTube entry is the no-cookie domain and omits allow-same-origin', () => {
    // The `youtube.com` embed sets a persistent cookie for every student who opens a lesson,
    // which in a school means a tracking identifier on every child in the year group.
    const yt = providerFor('youtube');
    expect(yt?.template('abc')).toContain('youtube-nocookie.com');
    // `allow-same-origin` is not needed to play a video and is what a sandbox escape needs.
    expect(yt?.sandbox).not.toContain('allow-same-origin');
  });

  it('an unknown provider returns null rather than throwing', () => {
    // A provider that throws during validation is a 500 in the renderer, which is a denial of
    // service on a content page.
    expect(providerFor('nope')).toBeNull();
    expect(providerFor('toString')).toBeNull();
    expect(providerFor('__proto__')).toBeNull();
  });
});

describe('the document envelope', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Orbits',
    authorId: id(),
    blocks: [{ type: 'paragraph', id: id(1), content: run('Hello') }],
    ...over,
  });

  it('accepts a well-formed document', () => {
    expect(validateDocument(doc()).ok).toBe(true);
  });

  it('requires a schemaVersion, which is what makes migration possible at all', () => {
    const r = validateDocument(doc({ schemaVersion: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'schemaVersion')).toBe(true);
  });

  it('rejects an unknown top-level field', () => {
    const r = validateDocument(doc({ html: '<script>alert(1)</script>' }));
    expect(r.ok).toBe(false);
    // `(document).html` rather than `html`: the key is reported at the DOCUMENT root, and
    // keeping the marker is what lets a caller tell a top-level problem from a block problem
    // without knowing which schema it called.
    if (!r.ok) expect(r.issues[0]?.path).toBe('(document).html');
  });

  it('names the failing block and field, not just "invalid"', () => {
    // The reason this module returns paths rather than a boolean. A 2,000-block document with
    // one broken image is otherwise unfixable.
    const r = validateDocument(
      doc({
        blocks: [
          { type: 'paragraph', id: id(1), content: run('fine') },
          { type: 'image', id: id(2), assetId: ASSET }, // alt missing
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'blocks.1.alt')).toBe(true);
    }
  });

  it('rejects a document with no authorId, because a diff without provenance is useless', () => {
    const r = validateDocument(doc({ authorId: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'authorId')).toBe(true);
  });

  it('accepts an EMPTY document — a lesson in progress is a valid state', () => {
    expect(validateDocument(doc({ blocks: [] })).ok).toBe(true);
  });

  it('the schema is exported for the renderer to type against', () => {
    expect(typeof documentSchema.parse).toBe('function');
  });
});

describe('nesting', () => {
  it('a columns block contains real blocks, and they are validated', () => {
    const r = validateBlock({
      type: 'columns',
      id: id(),
      columns: 2,
      children: [{ type: 'paragraph', id: id(1), content: run('left') }],
    });
    expect(r.ok).toBe(true);
  });

  it('and a bad child is reported with a path into the child', () => {
    const r = validateBlock({
      type: 'columns',
      id: id(),
      columns: 2,
      children: [{ type: 'image', id: id(1), assetId: ASSET }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path.includes('alt'))).toBe(true);
  });

  it('a columns block with no children is rejected, because it renders nothing', () => {
    const r = validateBlock({ type: 'columns', id: id(), columns: 2, children: [] });
    expect(r.ok).toBe(false);
  });

  it('only 2 or 3 columns, because 4 is unreadable at the widths students have', () => {
    expect(
      validateBlock({
        type: 'columns',
        id: id(),
        columns: 4,
        children: [{ type: 'divider', id: id(1), variant: 'solid' }],
      }).ok,
    ).toBe(false);
  });

  it('a list nests', () => {
    const r = validateBlock({
      type: 'list',
      id: id(),
      style: 'task',
      items: [{ id: id(1), content: run('a'), children: [{ id: id(2), content: run('b') }] }],
    });
    expect(r.ok).toBe(true);
  });
});

/** Compile-time: every listed type is a real union member. */
const _exhaustive: readonly Block['type'][] = BLOCK_TYPES;
void _exhaustive;
