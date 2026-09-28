/**
 * `/sitemap.xml` as a ROUTE HANDLER, not Next's `app/sitemap.ts` convention.  (P3-T6)
 *
 * Both can produce a sitemap. The convention is less code; this is a route handler because the
 * XML is produced by `renderSitemap`, which has unit tests for the escaping, the ordering and
 * the empty-`lastmod` case. Next's convention would mean the bytes are assembled by the
 * framework and the tested function is only exercised by tests nobody runs against the real
 * output — which is the "we tested the copy, not the thing" failure this project has hit three
 * times.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { sitemapResponse } = await import('@/server/seo');
  return sitemapResponse();
}
