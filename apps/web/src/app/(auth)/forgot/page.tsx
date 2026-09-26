'use client';

import { AuthPanel } from '@/features/auth/AuthPanel';
import { authTransport } from '@/server/auth/transport';

export default function ForgotPasswordPage() {
  return <AuthPanel transport={authTransport} mode="forgot" />;
}
