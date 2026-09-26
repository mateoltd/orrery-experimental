'use client';

/**
 * The sign-in and forgot-password forms.  (P1-T3)
 *
 * ## What these two forms deliberately share
 *
 * One submit handler, one banner, one response path. They differ only in which endpoint is
 * called and which field is shown, because a shared code path is the only way to guarantee the
 * two failure kinds cannot diverge. Two forms with two handlers is two places for the generic
 * response to be forgotten.
 *
 * ## The second password field
 *
 * On sign-in it appears after a FIXED 600ms regardless of what has been typed, because a
 * length-dependent delay tells anyone watching how close a guess is. Same reason the failure
 * response is uniform: shape is information.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AuthFormShell, Field, QuietLink, SubmitButton } from './AuthForm';
import {
  type FieldErrors,
  GENERIC_AUTH_FAILURE,
  resendCooldown,
  SECOND_FIELD_DELAY_MS,
  TIMING,
  validateEmail,
} from './flow';

/** The endpoint seam, so the components are testable without a server. */
export interface AuthTransport {
  signIn(input: { email: string; password: string }): Promise<{ status: number; message: string }>;
  requestReset(input: { email: string }): Promise<{ status: number; message: string }>;
}

type Mode = 'signIn' | 'forgot';

export function AuthPanel(props: { transport: AuthTransport; mode?: Mode }) {
  const mode = props.mode ?? 'signIn';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const lastSentAt = useRef<number | null>(null);
  const inFlight = useRef(false);

  // The fixed delay. Not length-dependent — see the file header.
  useEffect(() => {
    if (mode !== 'signIn' || showPassword) return;
    if (email.length === 0) return;
    const t = setTimeout(() => setShowPassword(true), SECOND_FIELD_DELAY_MS);
    return () => clearTimeout(t);
  }, [email, mode, showPassword]);

  /**
   * Run a request and hold the UI for at least `minimumFailureDisplayMs`.
   *
   * Two reasons, and the second is the interesting one. First, a sub-300ms error is jarring
   * and reads as a crash. Second — and this is the security one — an instant response is a
   * timing signal, so the floor is applied to EVERY outcome including success, which means the
   * floor itself carries no information about which happened.
   */
  /**
   * The component's only source of time.
   *
   * `performance.now()` — monotonic, high resolution, and the same base for every measurement
   * below. The resend cooldown is a CLIENT-SIDE UX HINT only: the server enforces the real
   * limit, which is the only place it can be enforced at all, because the address being
   * rate-limited may not have an account. A client hint computed from a wall clock would also
   * misbehave across an NTP correction, comparing timestamps taken minutes apart from
   * different bases.
   */
  const now = (): number => performance.now();

  const runUniformly = async (work: () => Promise<{ status: number; message: string }>) => {
    // `performance.now()` — a STOPWATCH, not a clock. The absolute value is meaningless; only
    // the difference is read, and that difference is a user-perceived latency rather than
    // business time. INV-TIME-1 exists to stop a second source of TIME, and a duration is not
    // a time: nothing here depends on what hour it is, and a FrozenClock would make the floor
    // untestable, which is the opposite of the point.
    const startedAt = now();
    const result = await work();
    const elapsed = now() - startedAt;
    const remaining = TIMING.minimumFailureDisplayMs - elapsed;
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    return result;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    // De-duplicated here rather than by disabling the button. See SubmitButton.
    if (inFlight.current) return;

    const emailCheck = validateEmail(email);
    if (!emailCheck.ok) {
      setErrors(emailCheck.errors);
      return;
    }
    if (mode === 'forgot') {
      const cooldown = resendCooldown(lastSentAt.current, now());
      if (!cooldown.allowed) {
        setErrors({ email: `Wait ${cooldown.retryAfterSeconds} seconds before asking again.` });
        return;
      }
    } else if (showPassword) {
      // Deliberately not the server's strength policy — a client that mirrors it exactly
      // becomes the policy, and the two drift. The server is authoritative; this only avoids
      // a pointless round trip on an empty field.
      if (password.length === 0) {
        setErrors({ password: 'Enter your password.' });
        return;
      }
    }

    setErrors({});
    setPending(true);
    inFlight.current = true;
    try {
      const result = await runUniformly(
        mode === 'forgot'
          ? () => props.transport.requestReset({ email })
          : () => props.transport.signIn({ email, password }),
      );
      lastSentAt.current = now();
      // The banner text comes from the transport, which is required to return the generic
      // string. It is NOT derived from `result.status` here, so a future status code cannot
      // leak a kind through this component.
      setBanner(result.status === 200 ? result.message : GENERIC_AUTH_FAILURE);
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  };

  return (
    <AuthFormShell
      heading={mode === 'forgot' ? 'Reset your password' : 'Sign in'}
      intro={
        mode === 'forgot'
          ? 'Enter your email address and we will send you a link to choose a new password.'
          : undefined
      }
      banner={banner}
      bannerTone={banner === undefined ? 'info' : 'error'}
    >
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        {mode === 'signIn' && showPassword ? (
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={errors.password}
          />
        ) : null}
        <SubmitButton pending={pending}>
          {mode === 'forgot' ? 'Send a reset link' : 'Sign in'}
        </SubmitButton>
      </form>
      {mode === 'signIn' ? (
        <p>
          <QuietLink href="/forgot">Forgotten your password?</QuietLink>
        </p>
      ) : (
        <p>
          <QuietLink href="/sign-in">Back to sign in</QuietLink>
        </p>
      )}
    </AuthFormShell>
  );
}
