import {
  RESULTS_HEADERS,
  type StudentResults,
} from '../../../../../packages/db/dist/student-results.js';

/** The route supplies an authenticated owner; missing and other-owner results share one response. */
export function resultsResponse(results: StudentResults | null): Response {
  return Response.json(results ?? { error: 'NOT_FOUND' }, {
    status: results === null ? 404 : 200,
    headers: RESULTS_HEADERS,
  });
}
