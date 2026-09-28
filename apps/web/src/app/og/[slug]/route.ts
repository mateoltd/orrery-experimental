/**
 * The Open Graph card for a resource.  (P3-T6)
 *
 * A route handler, and the security headers on the response are the point — see
 * `ogImageResponse` for why escaping alone is not enough and why a 404 is preferable to a
 * placeholder card.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const { ogImageResponse } = await import('@/server/seo');
  // The helper reads the slug back out of the URL, so the path has to be the one thing it sees.
  return ogImageResponse(new Request(`https://internal.invalid/og/${encodeURIComponent(slug)}`));
}
