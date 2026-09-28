/** `/robots.txt`, generated so the sitemap URL and the file cannot disagree.  (P3-T6) */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { robotsResponse } = await import('@/server/seo');
  return robotsResponse();
}
