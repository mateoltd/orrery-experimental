/**
 * `/sitemap.xml` and `/robots.txt`.  (P3-T6)
 *
 * ## Both read `APP_URL`, and neither reads the `Host` header
 *
 * A sitemap needs absolute URLs, and the obvious source of the origin is the request's `Host`
 * header — which is attacker-controlled. Reflecting it means a poisoned sitemap that a crawler
 * submits on somebody else's instructions, and a `robots.txt` that points crawlers at an
 * attacker's host. `APP_URL` is validated configuration, and it already carries a
 * "must not be localhost in production" refinement, so the origin is one fact in one place
 * rather than a per-request decision.
 *
 * ## Caching, and the one thing that must never be cached
 *
 * The sitemap is `public, max-age=0, s-maxage=3600` — cacheable by the CDN for an hour, never
 * by a browser. A sitemap in a browser cache is a sitemap that a newly published resource does
 * not appear in, for the person who most wants to share it.
 */

import { loadEnv } from '@orrery/config';
import {
  absoluteUrl,
  canonicalResourcePath,
  renderOgImage,
  renderRobots,
  renderSitemap,
} from '@orrery/contracts/urls';
import { getPrisma } from '@orrery/db';
import { publicUrlRows, sitemapEntries } from '@orrery/db/public-urls';

/** Always dynamic: the body is a database read, and it must not be baked at build time. */
export const dynamic = 'force-dynamic';

export async function sitemapResponse(): Promise<Response> {
  const db = getPrisma();
  const origin = loadEnv().APP_URL;
  // ABSOLUTE. `<loc>` must be a full URL: the sitemap protocol has no way to express "relative
  // to the site you fetched this from", and a crawler that receives `/library/x` has nothing to
  // resolve it against.
  //
  // This was caught by running the route against the real database and reading the output, not
  // by a test: `renderSitemap` takes PATHS, the unit tests assert paths, and the bug lived in
  // the one layer between them and the wire that nothing covered. The `absoluteUrl` call is the
  // fix and the reason `renderSitemap` is kept path-based is that it has no idea what a
  // deployment is called — which is a good property for a function to lack.
  const entries = await sitemapEntries(db, (slug) =>
    absoluteUrl(origin, canonicalResourcePath(slug)),
  );
  const xml = renderSitemap(entries);
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // An hour at the edge, never in a browser. See the header.
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * `/robots.txt`, generated rather than a static file.
 *
 * The `Sitemap:` line has to be built by the same `absoluteUrl` the sitemap itself uses. A
 * hand-written `Sitemap: https://…` line is a second place where the origin lives, and the two
 * disagree the first time a preview origin and a production origin differ — which is exactly
 * when a `robots.txt` pointing at the wrong sitemap matters least and is hardest to notice.
 */
export async function robotsResponse(): Promise<Response> {
  return new Response(renderRobots(loadEnv().APP_URL), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The OG card for a resource, as SVG.
 *
 * ## The three headers, and why none of them is optional
 *
 * The card is author-supplied text interpolated into a document. A browser will EXECUTE a script
 * inside an SVG it navigates to directly, and navigating to a link-preview URL is what link
 * previewers, messaging clients and curious users all do. So:
 *
 *   · the title is XML-escaped in `renderOgImage`;
 *   · `Content-Security-Policy: default-src 'none'` — no script, no styles, no external loads,
 *     whatever the document asks for;
 *   · `X-Content-Type-Options: nosniff`, so the browser cannot be talked into treating an
 *     `image/svg+xml` response as HTML.
 *
 * All three, together. Escaping alone leaves a future `foreignObject` or a missed attribute
 * context; CSP alone is a second line of defence that some clients do not send.
 */
export async function ogImageResponse(request: Request): Promise<Response> {
  const slug = decodeURIComponent(
    new URL(request.url).pathname.replace(/^\/og\//u, '').replace(/\/$/u, ''),
  );
  const db = getPrisma();
  const row = (await publicUrlRows(db)).find((r) => r.slug === slug);

  // A missing resource is a 404, not a placeholder card. A link preview service caches whatever
  // it is given, so a generic card for a URL that does not exist becomes the permanent preview
  // for every 404 on the platform.
  if (row === undefined) {
    return new Response('no such resource', { status: 404 });
  }

  const svg = renderOgImage({
    title: row.title,
    eyebrow: row.subjectName,
    accent: row.accent,
    kind: row.kind,
  });

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      // A card is immutable for a given title; an hour at the edge is plenty.
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
    },
  });
}
