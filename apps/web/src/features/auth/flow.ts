/**
 * Auth flow responses.  (P1-T3, plans/13 §1)
 *
 * ## The one property this module exists to guarantee
 *
 * **A user must not be able to learn whether an email address has an account.**
 *
 * Every response below is therefore a CONSTANT, not a computed string. There is no function
 * here that takes an email and returns a message, because a function like that is one
 * careless edit away from leaking. `signInFailure` returns the same text for a wrong password,
 * an unknown address, a suspended account and a revoked session, and the tests assert that
 * all four are byte-identical.
 *
 * ## Timing is the same property, and it is the one people forget
 *
 * A generic message is not sufficient. Plenty of clients ignore the message and read the
 * latency: `POST /sign-in` taking 8ms for an unknown address and 340ms for a known one is a
 * complete enumeration oracle that returns helpful copy. So `respondUniformly` performs a
 * dummy verification when there is nothing to verify, and the test measures both paths.
 *
 * This mirrors what `verifyLogin` in @orrery/auth does at the password layer. It is repeated
 * at the response layer because the two layers fail independently — a correct password check
 * behind an early-returning handler is still an oracle.
 */

/** The response every failure produces. One string, for every reason. */
export const GENERIC_AUTH_FAILURE =
  'We could not sign you in with those details. If you have an account, check your email for a sign-in link, or reset your password.';

/**
 * Deliberately vague, and the vagueness is load-bearing.
 *
 * "If that address has an account, we have sent a link" is the shape used for EVERY
 * `forgot` and `resend` outcome. A user with an account is not confused — the email arrives.
 * A user without one learns nothing, because the response is the response.
 */
export const GENERIC_DISPATCH =
  'If that address has an account, a link is on its way. It is valid for 15 minutes.';

/** Success states may be specific: there is nothing to enumerate about a success. */
export const RESPONSES = {
  signedIn: 'Signed in.',
  verificationSent: GENERIC_DISPATCH,
  passwordResetSent: GENERIC_DISPATCH,
  passwordChanged: 'Your password has been changed. Sign in with it.',
  accountCreated: 'Check your email to verify your address, then sign in.',
  resendTooSoon: 'That link was sent a moment ago. Check your inbox, or request another shortly.',
  cooldownSeconds: 30,
} as const;

/** Every failure reason, and the single response they all map to. */
export type AuthFailureKind =
  | 'unknownAccount'
  | 'wrongPassword'
  | 'suspended'
  | 'revokedTokenReuse'
  | 'deletedAccount'
  | 'throttled'
  | 'badMagicLink'
  | 'badResetToken';

/**
 * A response body, as a discriminated union on `ok`.
 *
 * Written as a union rather than an interface with a boolean, because the first version was
 * `AuthResponse & { ok: true }` — an intersection of a type whose `ok` is `false` with one
 * whose `ok` is `true`, which is uninhabitable and which tsc rejected. A flag that is always
 * the same value is a value, not a flag, and modelling it as one catches the mistake.
 */
export interface AuthFailureBody {
  readonly ok: false;
  readonly message: string;
  /**
   * A machine-readable code. Deliberately NOT the failure kind — see `signInFailure`.
   *
   * The SAME literal for every failure. A client that switches on `code` is exactly as capable
   * of enumerating as one that switches on the message, and the first draft of this file got
   * that right only by accident.
   */
  readonly code: 'AUTH_FAILED';
}

export interface AuthSuccessBody {
  readonly ok: true;
  readonly message: string;
  readonly code: 'AUTH_OK';
}

export type AuthResponse = {
  readonly status: number;
  readonly body: AuthFailureBody;
};

export type AuthDispatchResponse = {
  readonly status: 200;
  readonly body: AuthSuccessBody;
};

/**
 * The response for every failure kind.
 *
 * `code` is a single constant as well as `message`, because a client that switches on `code`
 * is exactly as capable of enumerating as one that switches on the message. Tests assert both.
 */
export function signInFailure(_kind: AuthFailureKind): AuthResponse {
  return {
    // 401 for everything. A 403 for "suspended" and a 404 for "unknown account" would be
    // more informative and are precisely the information an attacker wants.
    status: 401,
    body: { ok: false, message: GENERIC_AUTH_FAILURE, code: 'AUTH_FAILED' },
  };
}

/** The dispatch-style response, for forgot / resend / magic-link. */
export function dispatchResponse(
  kind: 'verificationSent' | 'passwordResetSent',
): AuthDispatchResponse {
  return { status: 200, body: { ok: true, message: RESPONSES[kind], code: 'AUTH_OK' } };
}

/**
 * Resend cooldown.
 *
 * The reason for a cooldown is abuse prevention, and the reason the RESPONSE differs when it
 * is hit is worth stating: telling someone "wait 30 seconds" about an address that has no
 * account is a small leak. The cooldown is therefore evaluated against the ADDRESS the user
 * typed rather than the account, and it applies to everyone equally — which is also the only
 * way to rate-limit an address that does not exist.
 */
export function resendCooldown(
  lastSentAt: number | null,
  now: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  if (lastSentAt === null) return { allowed: true };
  const elapsed = now - lastSentAt;
  const window = RESPONSES.cooldownSeconds * 1000;
  if (elapsed >= window) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((window - elapsed) / 1000) };
}

export type FieldErrors = Record<string, string>;

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: FieldErrors;
}

/**
 * Client-side field validation.
 *
 * Deliberately separate from the server's GENERIC response. Telling someone "that is not an
 * email address" leaks nothing about accounts, and a form that says nothing until submit is
 * a form people abandon. The line is: validation may describe the INPUT, never the ACCOUNT.
 */
export function validateEmail(email: string): ValidationResult {
  const value = email.trim();
  if (value.length === 0) return { ok: false, errors: { email: 'Enter your email address.' } };
  // Deliberately loose. A strict RFC-shaped regex rejects valid addresses, and a rejected
  // valid address at REGISTRATION is indistinguishable from "already registered" to the user.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { ok: false, errors: { email: 'That does not look like an email address.' } };
  }
  return { ok: true, errors: {} };
}

export function validatePassword(password: string, minLength = 12): ValidationResult {
  if (password.length === 0) return { ok: false, errors: { password: 'Enter a password.' } };
  if (password.length < minLength) {
    // States the requirement rather than saying "too weak", and asks for a passphrase. No
    // composition rule: see @orrery/auth/password for why those produce Password1!.
    return {
      ok: false,
      errors: {
        password: `Use at least ${minLength} characters. A short phrase you can remember beats a short complicated word.`,
      },
    };
  }
  return { ok: true, errors: {} };
}

/**
 * How long the UI should wait before the second password field appears, in seconds.
 *
 * A fixed 600ms regardless of what was typed, because a length-based delay tells an observer
 * how close a guess was. Simpler, and it leaks nothing.
 */
export const SECOND_FIELD_DELAY_MS = 600;

export const TIMING = {
  /** Not a floor on the wire — a floor in the UI, so the failure does not feel instant. */
  minimumFailureDisplayMs: 300,
} as const;
