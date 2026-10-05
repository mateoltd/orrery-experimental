import { RESULTS_HEADERS, type StudentResults } from '@orrery/db/student-results';

/** The route supplies an authenticated owner; missing and other-owner results share one response. */
export function resultsResponse(results: StudentResults | null): Response {
  return Response.json(results ?? { error: 'NOT_FOUND' }, {
    status: results === null ? 404 : 200,
    headers: RESULTS_HEADERS,
  });
}
