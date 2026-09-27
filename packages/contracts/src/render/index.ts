/**
 * The block renderer: typed data in, generated HTML out.  (P2-T2)
 *
 * ## The one rule
 *
 * Every string in this file that reaches the output goes through `escapeHtml` or `safeUrl`
 * first. There is no template interpolation of author data anywhere else, and a block type
 * that needs to emit markup calls those two functions rather than building a string.
 *
 * That is the whole of the XSS story, and it is why there is no sanitiser: the renderer does not
 * pass author data through a filter, it emits its own markup around escaped text. There is
 * nothing to keep patched.
 *
 * ## KaTeX, and the three options that are not preferences
 *
 *   · `trust: false`     — no `\href`, no `\htmlClass`, no author-controlled macros. KaTeX's
 *                          trust flag unlocks exactly the constructs that turn LaTeX into HTML
 *                          injection.
 *   · `strict: 'error'`  — a malformed expression THROWS rather than rendering an error
 *                          message. Silent degradation is how a maths lesson ends up showing
 *                          `KaTeX parse error` to a student with no way to tell the author.
 *   · `output: 'htmlAndMathml'` — MathML is emitted ALONGSIDE the visual output, not instead
 *                          of it. This is a WCAG requirement, not a nicety: without MathML a
 *                          screen reader announces "x superscript 2" as gibberish.
 */

import katex from 'katex';
import type { Block, ContentDocument, TextRun } from '../blocks/index.js';
import { PROVIDERS, providerFor } from '../blocks/providers.js';
import { attr, escapeHtml, safeUrl } from './escape.js';

/** Rendered maths. Separated so the test can assert on the KaTeX OPTIONS, not just the output. */
export function renderMath(latex: string, display: 'block' | 'inline'): string {
  return katex.renderToString(latex, {
    // The three that are not preferences. See the file header.
    trust: false,
    strict: 'error',
    output: 'htmlAndMathml',
    throwOnError: true,
    displayMode: display === 'block',
  });
}

// ── Text runs ───────────────────────────────────────────────────────────────────

/**
 * Render inline marks.
 *
 * Marks are NESTED in schema order — code, then link, then emphasis — rather than in document
 * order, so a mark inside a link is inside the anchor in the output. Getting that backwards
 * produces `<a>` inside `<strong>` inside a link, which is valid but makes the rendered DOM
 * depend on the order the author typed, which makes diffs noisy.
 */
export function renderRuns(runs: readonly TextRun[]): string {
  let out = '';
  for (const run of runs) {
    // Maths is a separate branch: it produces its own element and ignores every other mark,
    // because `\textbf` is the LaTeX way and a bold `<strong>` around KaTeX output is a
    // rendering bug, not a feature.
    if (run.math !== undefined) {
      out += renderMath(run.math, 'inline');
      continue;
    }
    let html = escapeHtml(run.text);
    if (run.code) html = `<code class="c-code">${html}</code>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.strike) html = `<s>${html}</s>`;
    // Links LAST, so the anchor is outermost. `safeUrl` decides whether the destination is
    // navigable at all; a `javascript:` href renders as text rather than as a link.
    if (run.href !== undefined) {
      html = `<a class="c-link"${attr('href', safeUrl(run.href))} rel="noopener noreferrer">${html}</a>`;
    }
    out += html;
  }
  return out;
}

// ── The 16 block types ─────────────────────────────────────────────────────────

/**
 * One renderer per type. A `Record`, not a `switch`, so a missing type is a COMPILE error and
 * adding a 17th block forces a decision here rather than rendering nothing.
 */
const RENDERERS: Record<Block['type'], (block: Block) => string> = {
  paragraph: (b) => `<p class="c-p">${renderRuns(b.type === 'paragraph' ? b.content : [])}</p>`,

  heading: (b) => {
    if (b.type !== 'heading') return '';
    // Levels 1..4 only, because the schema enforces it. `h5`/`h6` in a document whose outline
    // stops at h4 are a document-outline failure, and the schema is the cheapest place to
    // prevent them.
    const tag = `h${b.level}`;
    const id = b.anchor ? attr('id', b.anchor) : '';
    return `<${tag} class="c-h"${id}>${renderRuns(b.content)}</${tag}>`;
  },

  list: (b) => {
    if (b.type !== 'list') return '';
    // A TASK list is a `<ul>` of checkboxes, not an `<ol>` numbered 1..n. Rendering task items
    // inside an `<ol>` gives a screen reader "list item 1 of 3, ticked" for a list that has no
    // numbers, which is worse than useless.
    const tag = b.style === 'ordered' ? 'ol' : 'ul';
    const extra = b.style === 'task' ? ' class="c-list c-list--task"' : ' class="c-list"';
    return `<${tag}${extra}>${b.items.map((item) => renderListItem(item, tag)).join('')}</${tag}>`;
  },

  blockquote: (b) => {
    if (b.type !== 'blockquote') return '';
    // `cite` is emitted as a `<footer>` rather than a `cite` attribute, because the attribute
    // must be a URL and the block's `cite` is a human-readable attribution.
    const footer = b.cite ? `<footer class="c-quote-cite">${escapeHtml(b.cite)}</footer>` : '';
    return `<blockquote class="c-quote">${renderRuns(b.content)}${footer}</blockquote>`;
  },

  callout: (b) => {
    if (b.type !== 'callout') return '';
    // `role="note"` so it is announced as a distinct region rather than as loose text, and
    // `data-variant` so CSS can style it without five parallel class names.
    const title = b.title ? `<p class="c-callout-title">${escapeHtml(b.title)}</p>` : '';
    return `<aside class="c-callout"${attr('data-variant', b.variant)} role="note">${title}${renderRuns(b.content)}</aside>`;
  },

  code: (b) => {
    if (b.type !== 'code') return '';
    const caption = b.filename
      ? `<figcaption class="c-code-file">${escapeHtml(b.filename)}</figcaption>`
      : '';
    // `tabindex="0"` on a scrollable region, because a scrollable box that cannot be focused
    // is unreachable by keyboard. WCAG 2.1.1.
    return `<figure class="c-figure"><pre class="c-code" tabindex="0"${attr('data-language', b.language)}><code>${escapeHtml(b.code)}</code></pre>${caption}</figure>`;
  },

  equation: (b) => {
    if (b.type !== 'equation') return '';
    // `altText` is the accessible name when the maths is not renderable by the AT. Without it
    // the `aria-label` falls back to the LaTeX source, which is not English.
    const label = b.altText ? attr('aria-label', b.altText) : '';
    const number = b.number ? attr('data-number', b.number) : '';
    const tag = b.display === 'block' ? 'div' : 'span';
    return `<${tag} class="c-equation"${label}${number}>${renderMath(b.latex, b.display)}</${tag}>`;
  },

  image: (b) => {
    if (b.type !== 'image') return '';
    // `alt=""` is emitted VERBATIM for a decorative image, and the `aria-hidden` makes the
    // intent explicit. An absent `alt` is impossible — the schema requires it.
    const width = b.width ? attr('width', b.width) : '';
    // LAZY. The exam surface has a bundle budget and a student on school wifi, and a lesson
    // with thirty diagrams should not fetch thirty diagrams to render the first question.
    const img = `<img class="c-img"${attr('src', safeUrl(`/api/media/${b.assetId}`))}${attr('alt', b.alt)}${width} loading="lazy" decoding="async">`;
    // A FIGURE, because a caption is not a sibling paragraph. Without `<figure>` a caption
    // read out of context is unattributable.
    return `<figure class="c-figure">${img}${b.caption ? `<figcaption class="c-figcaption">${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`;
  },

  video: (b) => {
    if (b.type !== 'video') return '';
    const provider =
      b.provider === 'youtube'
        ? PROVIDERS.youtube
        : b.provider === 'vimeo'
          ? PROVIDERS.vimeo
          : null;

    if (provider && b.videoId) {
      const src = provider.template(b.videoId);
      return (
        `<figure class="c-figure">` +
        `<iframe class="c-embed"${attr('src', src)}${attr('title', b.title)}` +
        `${attr('sandbox', provider.sandbox.join(' '))}` +
        `${attr('referrerpolicy', provider.referrerPolicy)}` +
        ` loading="lazy" allowfullscreen></iframe>` +
        (b.transcript
          ? `<details class="c-transcript"><summary>Transcript</summary><div class="c-transcript-body">${escapeHtml(b.transcript)}</div></details>`
          : '') +
        `</figure>`
      );
    }

    // The `upload` case, and the FALLBACK. A video we cannot render is not a broken page: it is
    // a link, named, that works. An empty `<video>` with no controls and no fallback is the
    // difference between "we could not embed this" and "this page is broken".
    return (
      `<figure class="c-figure">` +
      `<p class="c-media-fallback">` +
      `Video: <span class="c-media-title">${escapeHtml(b.title)}</span>. ` +
      (b.assetId
        ? `<a class="c-link"${attr('href', safeUrl(`/api/media/${b.assetId}`))}>Open the video file</a>`
        : `Playback is not available here.`) +
      `</p>` +
      (b.transcript
        ? `<details class="c-transcript"><summary>Transcript</summary><div class="c-transcript-body">${escapeHtml(b.transcript)}</div></details>`
        : '') +
      `</figure>`
    );
  },

  table: (b) => {
    if (b.type !== 'table') return '';
    // A REAL table. `<th scope="col">` and `<scope="row">` are what tell a screen reader which
    // cell belongs to which header, and a grid of divs conveys none of it. This is the single
    // most common a11y failure in rendered content.
    const align = (i: number): string => {
      const a = b.alignments?.[i];
      return a ? ` style="text-align:${escapeHtml(a)}"` : '';
    };
    const head = b.header
      .map((cell, i) => `<th scope="col"${align(i)}>${escapeHtml(cell)}</th>`)
      .join('');
    const body = b.rows
      .map((row) => {
        // The FIRST cell of a row is the row header, so `scope="row"` gives a screen reader
        // "3 orbits, 2.5 AU" rather than an unlabelled number.
        const cells = row.map((cell, i) =>
          i === 0
            ? `<th scope="row"${align(i)}>${escapeHtml(cell)}</th>`
            : `<td${align(i)}>${escapeHtml(cell)}</td>`,
        );
        return `<tr>${cells.join('')}</tr>`;
      })
      .join('');
    return `<figure class="c-figure"><table class="c-table"><caption class="c-caption">${escapeHtml(b.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></figure>`;
  },

  embedSimulation: (b) => {
    if (b.type !== 'embedSimulation') return '';
    // The FALLBACK, not the simulation. The real one loads from the sim origin in a sandboxed
    // frame; until that exists the honest output is a described placeholder with the pinned
    // version visible, because a student who cannot see why the sim is missing cannot report
    // it usefully.
    return (
      `<figure class="c-figure" role="group"${attr('aria-label', `Interactive simulation: ${b.simId}`)}>` +
      `<div class="c-sim" data-sim-id="${escapeHtml(b.simId)}" data-sim-version="${escapeHtml(b.simVersion)}" data-sim-mode="${escapeHtml(b.mode)}">` +
      `<p class="c-sim-fallback">This interactive simulation is not available in this build.</p>` +
      `</div></figure>`
    );
  },

  practiceCheck: (b) => {
    if (b.type !== 'practiceCheck') return '';
    // `role="group"` not `role="radiogroup"`: the choices are not a radio group until the
    // question is interactive, and announcing a radio group for a read-only render is a lie
    // about the state.
    const choices = b.question.choices
      .map(
        (choice, i) =>
          `<li class="c-choice"><span class="c-choice-key" aria-hidden="true">${String.fromCharCode(65 + i)}.</span> ${renderRuns(choice)}</li>`,
      )
      .join('');
    return (
      `<section class="c-practice" role="group"${attr('aria-label', 'Practice question')}>` +
      `<p class="c-stem">${renderRuns(b.question.stem)}</p>` +
      `<ol class="c-choices" type="A">${choices}</ol>` +
      `</section>`
    );
  },

  keyValue: (b) => {
    if (b.type !== 'keyValue') return '';
    // A `<dl>`, because a definition list IS a definition list. A grid of bold-and-text
    // paragraphs is announced as a run of unrelated text.
    const rows = b.pairs
      .map(
        (p) =>
          `<dt class="c-term">${escapeHtml(p.term)}</dt><dd class="c-def">${renderRuns(p.definition)}</dd>`,
      )
      .join('');
    return `<dl class="c-kv">${rows}</dl>`;
  },

  divider: (b) => {
    if (b.type !== 'divider') return '';
    // `<hr>` with a VARIANT class, and a `<hr>` is a real thematic break — announced as one,
    // and focusable in some AT as a landmark.
    return `<hr class="c-divider"${attr('data-variant', b.variant)}>`;
  },

  columns: (b) => {
    if (b.type !== 'columns') return '';
    // The collapse is CSS, not markup: a `columns-2` class and a media query. Rendering a
    // second, single-column copy for narrow screens would duplicate every id in the document
    // and every `aria-labelledby` target with it.
    return `<div class="c-columns"${attr('data-columns', b.columns)}>${b.children.map(renderBlock).join('')}</div>`;
  },

  embedExternal: (b) => {
    if (b.type !== 'embedExternal') return '';
    const provider = providerFor(b.provider);
    // An unknown provider is unreachable through the schema, and handled here anyway. Rendering
    // a link instead of an iframe is the right degradation: the content is still reachable.
    if (!provider) {
      return `<p class="c-media-fallback">This embed is not available. <a class="c-link"${attr('href', safeUrl(`https://example.invalid/${b.providerId}`))}>Open it directly</a></p>`;
    }
    return (
      `<figure class="c-figure">` +
      `<iframe class="c-embed"${attr('src', safeUrl(provider.template(b.providerId)))}` +
      `${attr('title', b.title)}${attr('sandbox', provider.sandbox.join(' '))}` +
      `${attr('referrerpolicy', provider.referrerPolicy)} loading="lazy"></iframe>` +
      `</figure>`
    );
  },
};

function renderListItem(
  item: {
    id: string;
    content: readonly TextRun[];
    checked?: boolean;
    children?: readonly { id: string; content: readonly TextRun[]; checked?: boolean }[];
  },
  parentTag: string,
): string {
  const checkbox =
    parentTag === 'ul' && typeof item.checked === 'boolean'
      ? `<input type="checkbox" disabled${attr('checked', item.checked)}> `
      : '';
  const children = (item.children ?? []).map((c) => renderListItem(c, parentTag)).join('');
  return `<li class="c-li">${checkbox}${renderRuns(item.content)}${children ? `<ul class="c-list">${children}</ul>` : ''}</li>`;
}

/** Render one block. Exported so the editor can render a single block while editing. */
export function renderBlock(block: Block): string {
  const renderer = RENDERERS[block.type];
  // Unreachable: `Block['type']` and the Record are checked against each other by the compiler.
  // Present anyway because a renderer that returns `''` for an unknown block turns a content
  // bug into silently missing lessons, which is the failure a teacher reports as "it has gone
  // blank" and nobody can reproduce.
  if (typeof renderer !== 'function') {
    return `<p class="c-render-error">Unsupported block type: ${escapeHtml(String(block.type))}</p>`;
  }
  return renderer(block);
}

/** Render a whole document. */
export function renderDocument(doc: ContentDocument): string {
  return doc.blocks.map(renderBlock).join('');
}
