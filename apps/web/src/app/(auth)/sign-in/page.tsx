'use client';

import { AuthPanel } from '@/features/auth/AuthPanel';
import { authTransport } from '@/server/auth/transport';

/**
 * The sign-in page.
 *
 * A client component, because the form manages its own pending state and the uniform-response
 * floor — both of which need to happen in the browser for the floor to be observable. The
 * SERVER still decides every permission; this only controls when the user is told something.
 */
export default function SignInPage() {
  return <AuthPanel transport={authTransport} mode="signIn" />;
}
