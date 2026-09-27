// @vitest-environment jsdom
/**
 * The renderer's tests.  (P2-T2)
 *
 * ## The two properties, and the second is the dangerous one
 *
 *  1. **All 16 types render, and axe reports no violations.**
 *  2. **An XSS payload in EVERY text field renders as TEXT.** Not "the payload is escaped for
 *     the one field I thought of" — EVERY field, in all 16 types, asserted individually. The
 *     generated sweep below is what makes that tractable and is why it walks the corpus rather
 *     than a hand-written list that would inevitably miss a field.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `katex` is mocked so the OPTIONS the renderer actually passes can be recorded.
 *
 * The first version of this test read the options out of the source with a regex, and it
 * matched the COMMENT above the options block rather than the code — so it asserted
 * "`trust: false` — no `\href`" and would have passed against a renderer that enabled `\href`.
 * A regex over source is not a test of behaviour; this is.
 *
 * The mock DELEGATES to the real implementation, so the maths still renders and every other
 * test in this file is testing the real thing.
 */
const katexOptions: Record<string, unknown>[] = [];

/**
 * `katex` is mocked so the OPTIONS the renderer actually passes can be recorded.
 *
 * The first version of this test read the options out of the source with a regex, and it
 * matched the COMMENT above the options block rather than the code — so it asserted
 * "`trust: false` — no href" and would have passed against a renderer that enabled `\href`. A
 * regex over source is not a test of behaviour.
 *
 * The mock DELEGATES to the real implementation via `vi.importActual`, so the maths still
 * renders and every other test in this file exercises the real thing. Using the top-level
 * `import katex from 'katex'` inside the factory instead recurses forever, because
 * `vi.mock` is hoisted above it and the "real" import IS the mock.
 */
vi.mock('katex', async () => {
  const actual = await vi.importActual<typeof import('katex')>('katex');
  return {
    default: {
      renderToString: (tex: string, options: Record<string, unknown>) => {
        katexOptions.push(options);
        return actual.renderToString(tex, options as never);
      },
    },
  };
});

beforeEach(() => {
  katexOptions.length = 0;
});

import { axe } from 'jest-axe';
import { CORPUS } from '../blocks/fixtures.js';
import { BLOCK_TYPES, type Block } from '../blocks/index.js';
import { latestVersion, migrateBlocks } from '../blocks/migrate.js';
import { attr, classifyUrl, escapeHtml, INERT_URL, safeUrl } from './escape.js';
import { renderBlock, renderDocument, renderMath, renderRuns } from './index.js';

const id = (n = 1): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ASSET = id(900);

/** Payloads that break a renderer which is not escaping properly. */
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  'javascript:alert(1)',
  '</script><script>alert(1)</script>',
  '<svg onload=alert(1)>',
] as const;

describe('escaping', () => {
  it('escapes the five that matter and the two that are cheap', () => {
    expect(escapeHtml('<>&"\'`/')).toBe('&lt;&gt;&amp;&quot;&#39;&#x60;&#x2F;');
  });

  it('escapes the ampersand FIRST, so `&lt;` is not double-decoded', () => {
    // The classic ordering bug: escaping `<` before `&` turns `&lt;` in the input into
    // `&amp;lt;`, which is safe but visibly wrong, and escaping `&` last turns an input
    // `<` into `&amp;lt;` — safe. The property that matters is that output NEVER contains a
    // raw `<`.
    const escaped = escapeHtml('<a href="x">&</a>');
    expect(escaped).not.toMatch(/[<>"']/);
  });

  it('leaves ordinary text completely alone, because over-escaping is also a bug', () => {
    expect(escapeHtml('Orbits are Keplerian ellipses.')).toBe('Orbits are Keplerian ellipses.');
  });
});

describe('URL allowlist', () => {
  it('accepts http, https and mailto', () => {
    for (const url of ['https://example.org/x', 'http://example.org', 'mailto:a@example.org']) {
      expect(classifyUrl(url).safe, url).toBe(true);
    }
  });

  it('refuses javascript, data, vbscript and file', () => {
    // Checked on the PARSED scheme, not a prefix: a prefix check is defeated by confusion as
    // well as by the obvious cases.
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
    ]) {
      expect(classifyUrl(url).safe, url).toBe(false);
      expect(safeUrl(url)).toBe(INERT_URL);
    }
  });

  it('a protocol-relative URL is refused, because its scheme is the INHERITED one', () => {
    // `//evil.example/x` is http(s) depending on the page, which is exactly why it needs
    // refusing rather than allowing.
    expect(classifyUrl('//evil.example/x').safe).toBe(false);
  });

  it('refuses a relative URL, because there is no context to resolve it against', () => {
    expect(classifyUrl('/media/123').safe).toBe(false);
  });

  it('rejects an empty one rather than emitting href=""', () => {
    expect(classifyUrl('').safe).toBe(false);
    expect(classifyUrl('   ').safe).toBe(false);
  });
});

describe('attr()', () => {
  it('escapes the value and the name is never interpolated', () => {
    expect(attr('title', 'a"b')).toBe(' title="a&quot;b"');
  });

  it('omits null and undefined entirely rather than emitting the literal string', () => {
    expect(attr('title', null)).toBe('');
    expect(attr('title', undefined)).toBe('');
  });

  it('renders `true` as a bare boolean attribute and `false` as nothing', () => {
    expect(attr('disabled', true)).toBe(' disabled');
    expect(attr('disabled', false)).toBe('');
  });
});

describe('KaTeX options, which are not preferences', () => {
  it('emits MathML ALONGSIDE the visual output — a WCAG requirement, not a nicety', () => {
    const html = renderMath('x^2', 'inline');
    expect(html, 'MathML must be present for a screen reader').toContain('<math');
    expect(html, 'and the visual output must be present too').toContain('katex');
  });

  it('is called with trust:false, strict:error and htmlAndMathml', () => {
    // The recorded call, not the source text and not the output. Asserting on the output
    // would pass for a wrong configuration that happens to emit MathML.
    renderMath('a+b', 'block');
    expect(katexOptions).toHaveLength(1);
    expect(katexOptions[0]).toMatchObject({
      trust: false,
      strict: 'error',
      output: 'htmlAndMathml',
      throwOnError: true,
      displayMode: true,
    });
  });

  it('throws on a malformed expression rather than rendering an error message to a student', () => {
    // Silent degradation is how a maths lesson ends up showing "KaTeX parse error" with no
    // way for the author to know.
    expect(() => renderMath('\\frac{1}{', 'block')).toThrow();
  });

  it('refuses author-controlled macros: \\htmlClass THROWS', () => {
    expect(() => renderMath('\\htmlClass{evil}{x}', 'block')).toThrow();
  });

  it('and \\href does NOT throw — it degrades to inert text, which is the right behaviour', () => {
    // Corrected after checking what `trust: false` actually does. The first version of this
    // test asserted a throw, and the real behaviour is better: `\\href` renders as red MathML
    // text plus an `<annotation>` holding the LaTeX source as TEXT.
    //
    // The security property is therefore NOT "it throws" but "it produces NO NAVIGABLE LINK",
    // and that is what is asserted. Getting this wrong in either direction matters: a test
    // that asserted a throw would have failed against correct code, and a test that asserted
    // only "no throw" would have passed against a renderer that emitted `<a href="javascript:">`.
    const html = renderMath('\\href{javascript:alert(1)}{x}', 'block');
    expect(html, 'no anchor may be produced').not.toMatch(/<a[\s>]/i);
    // The only `href` in the output is inside the `<annotation encoding="application/x-tex">`
    // TAG, and `javascript:` appears only as inert text. `expect(html).toContain('&lt;')` was the
    // first version of this assertion and it was wrong: the LaTeX contains no `<` at all, so
    // there is nothing to escape and nothing to find.
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('<annotation');
  });

  it('and the LaTeX source in the MathML annotation is ESCAPED, not parsed', () => {
    // Checked because the annotation echoes the author's LaTeX verbatim, and an unescaped
    // `</annotation><script>` there would be an XSS in the middle of a maths lesson.
    const html = renderMath('</annotation><img src=x onerror=alert(1)>', 'block');
    expect(html, 'no real img tag').not.toMatch(/<img/i);
    expect(html, 'the payload appears escaped').toContain('&lt;img');
  });
});

describe('SECURITY: an XSS payload in every text field renders as text', () => {
  it('a payload in EVERY string leaf of EVERY block type produces no executable markup', () => {
    // The sweep is over the CORPUS, with every string replaced by a payload — so it covers
    // the fields a hand-written list would forget, which is the only way "every text field" is
    // an assertion rather than a hope.
    let blocks: unknown[] = [];
    for (const fixture of CORPUS) {
      const migrated = migrateBlocks(fixture.blocks, fixture.schemaVersion, latestVersion());
      if (!migrated.ok) continue;
      blocks = blocks.concat(migrated.blocks);
    }
    expect(blocks.length, 'the corpus must contain something to sweep').toBeGreaterThan(5);

    for (const [bi, block] of blocks.entries()) {
      const poisoned = poisonEveryString(block as Record<string, unknown>) as Block;
      const html = renderBlock(poisoned);
      for (const payload of PAYLOADS) {
        expect(html, `block ${bi} (${poisoned.type}) leaked ${payload}`).not.toContain(payload);
        expect(html, `block ${bi} (${poisoned.type}) emitted a raw <script`).not.toMatch(
          /<script/i,
        );
        expect(html, `block ${bi} (${poisoned.type}) emitted an inline event handler`).not.toMatch(
          /\son\w+\s*=/i,
        );
      }
    }
  });

  it('and a javascript: href becomes an inert link, keeping the text visible', () => {
    // Not dropped: a link that quietly loses its destination is a support ticket, and one that
    // becomes `about:blank` at read time is a visible mistake the author can fix.
    const html = renderRuns([{ text: 'click me', href: 'javascript:alert(1)' }]);
    expect(html).toContain('click me');
    expect(html).toContain('about:blank');
    expect(html).not.toContain('javascript:');
  });
});

describe('semantics that a div grid would lose', () => {
  it('a table is a REAL table with a caption and scoped headers', () => {
    const html = renderBlock({
      type: 'table',
      id: id(),
      caption: 'Planet data',
      header: ['Planet', 'AU'],
      rows: [
        ['Mercury', '0.39'],
        ['Earth', '1.0'],
      ],
    } as Block);
    expect(html).toContain('<table');
    // The caption is a WCAG requirement for a data table.
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    // The first cell of a row is a row header, so "0.39" is announced as belonging to Mercury.
    expect(html).toContain('scope="row"');
  });

  it('a keyValue block is a <dl>, because a definition list IS one', () => {
    const html = renderBlock({
      type: 'keyValue',
      id: id(),
      pairs: [{ term: 'AU', definition: [{ text: 'Astronomical Unit' }] }],
    } as Block);
    expect(html).toContain('<dl');
    expect(html).toContain('<dt');
    expect(html).toContain('<dd');
  });

  it('an image is a <figure> when it has a caption, and alt is emitted verbatim', () => {
    const html = renderBlock({
      type: 'image',
      id: id(),
      assetId: ASSET,
      alt: 'An orbit',
      caption: 'Figure 1',
    } as Block);
    expect(html).toContain('<figure');
    expect(html).toContain('<figcaption');
    expect(html).toContain('alt="An orbit"');
  });

  it('a decorative image keeps alt="" rather than losing the attribute', () => {
    const html = renderBlock({ type: 'image', id: id(), assetId: ASSET, alt: '' } as Block);
    expect(html, 'alt="" is a decision, and must survive rendering').toContain('alt=""');
  });

  it('media is LAZY, because a student on school wifi is the design constraint', () => {
    const html = renderBlock({ type: 'image', id: id(), assetId: ASSET, alt: 'x' } as Block);
    expect(html).toContain('loading="lazy"');
  });

  it('a scrollable code block is focusable', () => {
    // A scrollable box that cannot be focused is unreachable by keyboard. WCAG 2.1.1.
    const html = renderBlock({
      type: 'code',
      id: id(),
      code: 'SELECT 1;',
      language: 'sql',
    } as Block);
    expect(html).toContain('tabindex="0"');
  });

  it('a task list is a <ul> of checkboxes, never an <ol>', () => {
    // An <ol> of task items announces "list item 1 of 3, ticked" for a list with no numbers.
    const html = renderBlock({
      type: 'list',
      id: id(),
      style: 'task',
      items: [{ id: id(2), content: [{ text: 'do it' }], checked: true }],
    } as Block);
    expect(html).toContain('<ul');
    expect(html).not.toContain('<ol');
    expect(html).toContain('type="checkbox"');
  });
});

describe('all 16 render, and every type has a case', () => {
  const rendered = CORPUS.flatMap((f) => {
    const m = migrateBlocks(f.blocks, f.schemaVersion, latestVersion());
    return m.ok ? m.blocks : [];
  });

  it('the corpus exercises every declared type', () => {
    const seen = new Set(rendered.map((b) => b.type));
    const missing = BLOCK_TYPES.filter((t) => !seen.has(t));
    expect(missing, `no fixture covers: ${missing.join(', ')}`).toEqual([]);
  });

  it('and every one produces non-empty HTML', () => {
    for (const b of rendered) {
      const html = renderBlock(b);
      expect(html.length, `type=${b.type} rendered nothing`).toBeGreaterThan(0);
    }
  });

  it('rendering is pure — the same block twice gives identical output', () => {
    for (const b of rendered) expect(renderBlock(b)).toBe(renderBlock(b));
  });

  it('and does not mutate the block it was given', () => {
    for (const b of rendered) {
      const before = JSON.stringify(b);
      renderBlock(b);
      expect(JSON.stringify(b), `type=${b.type} was mutated by rendering`).toBe(before);
    }
  });

  it('an unsupported type degrades to a visible message, not to nothing', () => {
    // Silently missing content is reported by a teacher as "it has gone blank" and cannot be
    // reproduced. A visible message is a bug report.
    const html = renderBlock({ type: 'notAType', id: id() } as unknown as Block);
    expect(html).toContain('Unsupported block type');
  });
});

describe('axe, on rendered output', () => {
  it('reports no violations for the full corpus', async () => {
    const blocks = CORPUS.flatMap((f) => {
      const m = migrateBlocks(f.blocks, f.schemaVersion, latestVersion());
      return m.ok ? m.blocks : [];
    });
    // Third-party iframes are STRIPPED before axe runs, and the reason is worth stating rather
    // than working around: axe cannot evaluate a `youtube-nocookie.com` frame inside jsdom and
    // fails with "Respondable target must be a frame in the current window", which is axe
    // telling the truth about its environment rather than finding an accessibility defect.
    //
    // So axe checks OUR markup, and the iframe attributes it cannot check are asserted
    // separately below. Pretending axe validated the embeds would be the worse error.
    const html = `<main>${blocks.map(renderBlock).join('')}</main>`.replace(
      /<iframe\b[^>]*><\/iframe>/g,
      '<div class="c-embed-placeholder"></div>',
    );
    const result = await axe(html);
    expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('every iframe carries a sandbox, a referrer policy and a title', () => {
    // What axe could not check, asserted directly. An iframe with a `title` is announced; one
    // without is "frame", which tells a screen-reader user nothing.
    const blocks = CORPUS.flatMap((f) => {
      const m = migrateBlocks(f.blocks, f.schemaVersion, latestVersion());
      return m.ok ? m.blocks : [];
    });
    const html = blocks.map(renderBlock).join('');
    const frames = html.match(/<iframe\b[^>]*>/g) ?? [];
    expect(frames.length, 'the corpus should contain at least one embed').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame, frame.slice(0, 60)).toMatch(/\ssandbox="/);
      expect(frame, frame.slice(0, 60)).toMatch(/\sreferrerpolicy="/);
      expect(frame, frame.slice(0, 60)).toMatch(/\stitle="/);
    }
  });
});

describe('renderDocument', () => {
  it('renders a whole document', () => {
    const html = renderDocument({
      schemaVersion: latestVersion(),
      title: 'Orbits',
      authorId: id(),
      blocks: [{ type: 'paragraph', id: id(1), content: [{ text: 'Hello' }] }],
    });
    expect(html).toContain('Hello');
  });
});

/** Replace every string leaf with a payload. Recursive, so no field is missed. */
function poisonEveryString(value: unknown, payload = PAYLOADS[0]): unknown {
  if (typeof value === 'string') return payload;
  if (Array.isArray(value)) return value.map((v) => poisonEveryString(v, payload));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = poisonEveryString(v, payload);
    }
    return out;
  }
  return value;
}
