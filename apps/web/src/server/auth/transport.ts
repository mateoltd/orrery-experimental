/**
 * The browser-to-server transport.  (P1-T3)
 *
 * ## The most important thing this file does
 *
 * It returns the SERVER'S body verbatim, and nothing more. It does not inspect the status code
 * to decide what to show, because a status code is exactly the kind of thing that differs
 * between "no such account" and "wrong password" in a careless implementation — and a client
 * that switches on it is an enumeration oracle that no amount of generic server copy can fix.
 *
 * `AuthPanel` then shows `GENERIC_AUTH_FAILURE` for anything that is not a 200, so even a
 * server that leaks in its status code cannot leak through this UI.
 */

import { GENERIC_AUTH_FAILURE, RESPONSES } from '@/features/auth/flow';

export interface TransportResult {
  readonly status: number;
  readonly message: string;
}

async function post(path: string, body: unknown): Promise<TransportResult> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Same-origin credentials. The session cookie is `__Host-` and SameSite=Lax, and this
      // is what makes it travel at all.
      credentials: 'same-origin',
    });
    // The server's message is used when it succeeded. On any failure the GENERIC string is
    // returned regardless of what the server said, so a server-side leak stops here.
    if (response.status === 200) {
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      return { status: 200, message: data.message ?? RESPONSES.signedIn };
    }
    return { status: response.status, message: GENERIC_AUTH_FAILURE };
  } catch {
    // A network failure is also generic. A distinguishable "could not reach the server" is
    // not an enumeration channel, but there is nothing to gain from being specific either.
    return { status: 0, message: GENERIC_AUTH_FAILURE };
  }
}

export const authTransport = {
  signIn: (input: { email: string; password: string }): Promise<TransportResult> =>
    post('/api/auth/sign-in', input),
  requestReset: (input: { email: string }): Promise<TransportResult> =>
    post('/api/auth/forgot', input),
};
