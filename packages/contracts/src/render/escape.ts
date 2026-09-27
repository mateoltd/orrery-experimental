/**
 * HTML escaping, URL allowlists, and the only two ways content becomes markup.  (P2-T2)
 *
 * ## The security model, stated once
 *
 * `plans/05` §1: author content is a CLOSED UNION, never free HTML, so the renderer only ever
 * emits HTML it generates itself. That decision lives in the schema. This file is the other
 * half of it: the one place where a string becomes markup, and the only place where a string
 * becomes a URL.
 *
 * There are exactly two escape hatches in the entire renderer and they are these two
 * functions. A new block type that needs to emit markup calls them; it does not build a string.
 *
 * ## Why the URL allowlist is here and not in the schema
 *
 * Because a URL is not a string, it is a place the browser will GO. `text` in an equation is
 * just characters; `href` is an instruction. A schema regex cannot express "this is safe to
 * navigate to", only "this has the right characters", and the difference between the two is
 * where `javascript:` lives.
 *
 * The scheme list is a positive allowlist — `http`, `https`, `mailto` — and anything else is
 * REWRITTEN to a harmless `about:blank`-style value rather than dropped. Dropping it would
 * render a link with no destination, which is a broken link an author will file a bug about;
 * rewriting it keeps the text visible and makes the link inert, which is a visible mistake the
 * author can fix.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
};

/**
 * Escape a string for use in element CONTENT or a quoted attribute.
 *
 * `/` and `` ` `` are escaped as well as the obvious five. Neither is required for correctness
 * in every context, and both are cheap:
 *   · `/` matters when a string is interpolated into a `<script>` block or an unquoted
 *     attribute, and `</script` is the classic way out of one.
 *   · `` ` `` matters in older IE's attribute parsing and in template-literal contexts, and it
 *     costs one entity.
 *
 * The set is deliberately a superset of the minimum. An over-escaping bug is a stray `&#x2F;`
 * visible in a URL; an under-escaping bug is an XSS.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"'`/]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Schemes a browser will navigate to. Everything else is inert. */
export const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** What a rejected URL becomes. Visible enough that the author notices. */
export const INERT_URL = 'about:blank#unsafe-link-removed';

export type SafeUrl =
  | { readonly safe: true; readonly url: string }
  | { readonly safe: false; readonly reason: string };

/**
 * Decide whether a URL may be emitted, without emitting it.
 *
 * SEPARATE from `safeUrl` so the editor can show a warning BEFORE the author saves, rather than
 * silently rewriting on render. A link that quietly becomes `about:blank` at read time is a
 * support ticket; one that is flagged at write time is a one-line fix.
 *
 * The check is on the PARSED scheme, not on a prefix match. `https://x` and
 * ` javascript:alert(1)` both start with a letter, and a prefix check like
 * `url.startsWith('https')` is defeated by `https:/\/evil` style confusion as well as by the
 * obvious ones.
 */
export function classifyUrl(raw: string): SafeUrl {
  const trimmed = raw.trim();
  if (trimmed === '') return { safe: false, reason: 'empty' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { safe: false, reason: 'not an absolute URL' };
  }

  if (!(SAFE_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    return { safe: false, reason: `scheme ${parsed.protocol} is not allowed` };
  }
  return { safe: true, url: parsed.toString() };
}

/** The URL to emit: the original if it is safe, an inert one if not. */
export function safeUrl(raw: string): string {
  const verdict = classifyUrl(raw);
  return verdict.safe ? verdict.url : INERT_URL;
}

/**
 * A value for a `src`/`href` attribute, including the quotes.
 *
 * Every attribute in the renderer goes through this. It exists so that a block type cannot
 * emit `src="${something}"` by accident, which is the one mistake that turns a renderer into
 * an XSS with a two-line diff.
 */
export function attr(name: string, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${escapeHtml(String(value))}"`;
}
