/**
 * Public URLs, sitemaps and OG images.  (P3-T6)
 *
 * ## One function owns the canonical path
 *
 * `canonicalResourcePath` is the only place a public resource URL is written down, and it is
 * used by all three consumers: the page's `<link rel="canonical">`, the OG `og:url`, and the
 * sitemap. Three copies of a path template is three chances for the sitemap to list a URL that
 * the page then canonicalises somewhere else — and a sitemap listing a non-canonical URL is not
 * a cosmetic bug, it is a signal that says "index this one" about a page that says "index that
 * one", and the crawler is entitled to believe either.
 *
 * ## The subject is NOT in the path, and that is the whole argument
 *
 * The obvious public URL is `/library/maths/algebra/quadratics`: keyword-rich, human-readable,
 * what a CMS would generate. It is also wrong here, because **`moveSubject` is a real, shipped,
 * cycle-safe feature** (P3-T1) and moving a subject would break the URL of every resource
 * beneath it. Not "might break" — would, silently, for a tree of 246 subjects that an admin can
 * reorganise.
 *
 * The options were: put the subject in the path and accept that a reorganisation is a
 * site-wide redirect problem; or use an id, which is stable and unreadable; or drop the subject
 * and let the subject be a breadcrumb. The third is what this does. A subject move becomes
 * invisible to every URL on the platform, which is the correct outcome for a reorganisation that
 * changes no content.
 *
 * Dropping it costs two things, and both are handled rather than ignored:
 *
 *  1. **Ambiguity.** Two public resources cannot share a slug. Enforced by a PARTIAL unique
 *     index — `UNIQUE (slug) WHERE visibility = 'PUBLIC'` — so uniqueness is required exactly
 *     where the URL is ambiguous and NOT required in the authors' private libraries, where two
 *     teachers each having a draft called `quadratics` is correct and expected. A global unique
 *     index on `slug` would have been the wrong constraint, and it is the kind of wrong that
 *     looks right.
 *  2. **Renames.** A slug derived from a title would change when the title changes. So the slug
 *     is assigned ONCE at creation and is **immutable**, and the title is free to change
 *     forever. That is what removes the need for a redirect table: there is no rename path, so
 *     there is nothing to redirect. Chosen over an alias table because an alias table is a
 *     second place to keep URLs in step, and a second place is a second thing to get out of
 *     step. If resource renames are ever a requirement, this is the file to revisit.
 *
 * ## The sitemap is a PUBLIC SURFACE and is filtered like one
 *
 * A sitemap is crawled, cached by third parties, and submitted to search engines. Anything it
 * lists is discoverable by anyone who has never signed in. It is built from the SAME
 * `PUBLIC_LISTING` predicate as the public library and the search — which means it inherits the
 * `plans/05` §6 under-18 rule, and a resource authored by a minor is absent from it. This is the
 * single most important property in this file, and it is the reason the listing predicate is
 * exported from one place rather than re-expressed per surface.
 *
 * ## The OG image is SVG, and an SVG is a document
 *
 * No image library and no raster output: the card is generated as SVG, which is text, which
 * means it is testable as a pure function and reviewable as a diff.
 *
 * The consequence is that **an SVG can contain a `<script>`**, and a server that returns one
 * with `Content-Type: image/svg+xml` will execute it when the URL is navigated to directly —
 * which is exactly what a link preview service, a messaging client, or a curious user does. So
 * three things are required together and none of them is sufficient alone: every interpolated
 * value is XML-escaped; the response carries `Content-Security-Policy: default-src 'none'`; and
 * it carries `X-Content-Type-Options: nosniff` so the browser cannot be talked into treating it
 * as HTML. `renderOgImage` does the escaping and the route sets the headers, and there is a test
 * that puts a script payload through the title.
 */

/* ------------------------------------------------------------------ *
 * The canonical path
 * ------------------------------------------------------------------ */

/** Where public resources live. One prefix, used by every consumer. */
export const LIBRARY_PREFIX = '/library';

/**
 * The canonical public path for a resource.
 *
 * Takes the slug, never the subject and never the id. See the header for why the subject is
 * absent: a subject move must not break a URL.
 */
export function canonicalResourcePath(slug: string): string {
  // ENCODE, and only the path segment. A slug is already constrained to `[a-z0-9-]` by
  // `toSlug`, so this is defence in depth rather than the primary defence — but the input is a
  // database value rather than a validated one, and a stray `/` or `?` in a slug would
  // otherwise reshape the path into a different route.
  return `${LIBRARY_PREFIX}/${encodeURIComponent(slug)}`;
}

/** Absolute, for `og:url` and sitemap `<loc>`. Trailing slashes are normalised away. */
export function absoluteUrl(origin: string, path: string): string {
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * `robots.txt`, as text.
 *
 * A generator and not a file, for one reason: the sitemap URL has to be the same
 * `absoluteUrl(origin, …)` the sitemap itself uses, or the two disagree about where the site
 * lives. A hardcoded `Sitemap:` line is a second source of truth for the origin.
 *
 * The Disallow rules are worth stating rather than leaving as a default. `/exam/` is not merely
 * private: an exam attempt URL is guessable from an attempt id, and indexing one is a way for a
 * timed assessment to leak. `/api/` is not a thing yet and costs nothing to reserve.
 */
export function renderRobots(origin: string): string {
  return [
    'User-agent: *',
    'Disallow: /exam/',
    'Disallow: /api/',
    'Allow: /',
    `Sitemap: ${absoluteUrl(origin, '/sitemap.xml')}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Sitemap
 * ------------------------------------------------------------------ */

export interface SitemapEntry {
  readonly path: string;
  /** ISO date, `YYYY-MM-DD`. Only the DATE: a timestamp makes crawlers re-fetch constantly. */
  readonly lastmod: string;
  readonly changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  readonly priority?: number;
}

/**
 * A search engine's protocol caps one sitemap at 50,000 URLs. Beyond that the spec requires a
 * sitemap INDEX of sitemaps. The cap is exported so a caller can notice it is close, rather than
 * discovering it as a silently truncated file.
 */
export const SITEMAP_URL_LIMIT = 50_000;

/**
 * `renderSitemap`.
 *
 * Renders `<?xml …?>` with a URLSET. Entries are SORTED, because a sitemap whose byte order
 * changes on every build is one crawlers refetch for no reason, and because a stable order makes
 * a diff of two sitemaps readable.
 */
export function renderSitemap(entries: readonly SitemapEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = sorted
    .map((e) => {
      const parts = [`    <loc>${escapeXml(e.path)}</loc>`];
      if (e.lastmod !== '') parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
      if (e.changefreq !== undefined) parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) {
        parts.push(`    <priority>${e.priority.toFixed(1)}</priority>`);
      }
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/**
 * The ISO date, or `''`.
 *
 * Empty rather than a fabricated date: an invented `lastmod` is a lie told to a crawler about
 * when content changed, and a lie in a file nobody reads is still a lie.
 *
 * An INVALID date returns `''` rather than throwing. `toISOString()` raises a `RangeError` on an
 * invalid `Date`, and a sitemap that throws while rendering is a sitemap that does not exist —
 * so a single bad row would take out the file for every other row. The failure the first test
 * run produced: `Invalid time value`, from a value that reached the function as a `Date` and so
 * looked safe by its type.
 */
export function sitemapLastmod(updatedAt: Date): string {
  const millis = updatedAt.getTime();
  if (!Number.isFinite(millis)) return '';
  return new Date(millis).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * OG image
 * ------------------------------------------------------------------ */

/**
 * XML-escaping, for a document that interpolates untrusted text.
 *
 * Separate from `escapeHtml`, and deliberately: HTML escaping is not XML escaping. `escapeHtml`
 * covers `< > & " '` for an HTML context, which happens to be sufficient for XML text nodes
 * too — but the apostrophe escaping differs (`&#39;` is an HTML-ism) and the two functions have
 * different failure modes if either is edited. One function per document type, and the shared
 * core is small enough to see.
 *
 * Also strips control characters that are illegal in XML 1.0 outright. A title containing U+0001
 * makes the document unparseable, and an unparseable sitemap is one crawlers silently discard.
 */
export function escapeXml(input: string): string {
  // The illegal characters are stripped with an explicit CODE-POINT predicate, not a
  // character-class regex.
  //
  // The regex was correct and fought the linter for three attempts: a literal naming `\u0000`
  // reads as "unexpected control characters" to every tool that looks at it, and the
  // `biome-ignore` needed for it kept silently failing to attach. A suppression that fights back
  // is worse than the code it suppresses. Stating the rule as a function says what it means and
  // needs no exemption at all: below 0x20, and not one of the three whitespace characters XML 1.0
  // explicitly allows.
  const isLegalXmlChar = (ch: string): boolean => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  };
  return input
    .split('')
    .filter(isLegalXmlChar)
    .join('')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

export interface OgCard {
  readonly title: string;
  /** Subject name, shown as the eyebrow. `null` for a resource with no subject. */
  readonly eyebrow: string | null;
  /** Subject colour as `#rrggbb`, from the root of the subject's area. `null` for a fallback. */
  readonly accent: string | null;
  readonly kind: string;
}

/**
 * The OG card, as SVG.
 *
 * 1200×630, which is Open Graph's own recommendation and the size every consumer crops for.
 *
 * The layout is fixed and the text is CLIPPED rather than wrapped. A wrapped title needs font
 * metrics to know where to break, and guessing them means a card that overflows for a long
 * title in a language whose glyphs are wider than the one the guess assumed — so the honest
 * choice is to truncate to a character budget and put the full title in `og:title`, which is
 * text and is never truncated. A card that is slightly wrong about a long title is a cosmetic
 * problem; a card that is unparseable or executes a script is a security problem.
 */
export function renderOgImage(card: OgCard): string {
  const title = clip(card.title, 90);
  const eyebrow = card.eyebrow === null ? 'ORRERY' : clip(card.eyebrow.toUpperCase(), 28);
  const accent = /^#[0-9a-f]{6}$/i.test(card.accent ?? '') ? (card.accent as string) : '#334155';
  const kind = clip(card.kind.replace(/_/gu, ' '), 24);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(clip(card.title, 120))}">
  <rect width="1200" height="630" fill="#0b1120"/>
  <rect x="0" y="0" width="1200" height="12" fill="${escapeXml(accent)}"/>
  <text x="80" y="150" font-family="system-ui, sans-serif" font-size="30" font-weight="600" fill="${escapeXml(accent)}" letter-spacing="4">${escapeXml(eyebrow)}</text>
  <text x="80" y="290" font-family="system-ui, sans-serif" font-size="76" font-weight="700" fill="#f8fafc">${escapeXml(title)}</text>
  <text x="80" y="540" font-family="system-ui, sans-serif" font-size="34" fill="#94a3b8">${escapeXml(kind)}</text>
  <text x="80" y="586" font-family="system-ui, sans-serif" font-size="26" fill="#64748b" letter-spacing="3">ORRERY</text>
</svg>
`;
}

/**
 * Clip to a character budget, with an ellipsis when anything was cut.
 *
 * By code point, not by code unit, so an emoji or an astral character is not cut in half into a
 * replacement character. A card ending in U+FFFD is a visible bug that a byte-length check
 * cannot see and a code-point slice does.
 */
export function clip(input: string, max: number): string {
  const chars = [...input.replace(/\s+/gu, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
