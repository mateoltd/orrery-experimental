'use client';

/**
 * Auth form primitives.  (P1-T3)
 *
 * ## The accessibility decisions, and why they are here rather than per-form
 *
 * Every one of these was a bug in a previous version of a form in this product, so they are
 * made once and used everywhere:
 *
 *   · **The label is a real `<label htmlFor>`.** A placeholder is not a label: it disappears
 *     on focus, it is not announced reliably, and it fails WCAG 2.2 3.3.2 (Labels or
 *     Instructions) and 4.1.2 (Name, Role, Value).
 *   · **The error is associated with `aria-describedby` AND announced.** An error rendered
 *     above or below a field is invisible to a screen-reader user unless it is referenced from
 *     the field, and it must be `role="alert"` so it is announced when it APPEARS — a
 *     validation error that exists in the DOM from first render is silent.
 *   · **The error region exists in the DOM before it has content.** `role="alert"` announces
 *     *changes* to a live region; a region inserted at the same moment as its content is
 *     frequently missed entirely.
 *   · **`aria-invalid`** is set on the field, not just the colour.
 *   · **Nothing is autofocus'd.** See the exam error boundary for why.
 *   · **The submit button is never disabled to prevent submission.** A disabled button is
 *     invisible to a keyboard user mid-flow and gives no explanation; the form validates and
 *     reports instead.
 */

import { type ReactNode, useId } from 'react';

export interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly type?: 'email' | 'password' | 'text';
  readonly name: string;
  readonly error?: string | undefined;
  readonly autoComplete?: string;
  readonly hint?: string;
  readonly required?: boolean;
}

export function Field(props: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Both ids are referenced, in a stable order, so a screen reader reads hint then error.
  const describedBy = [props.hint ? hintId : null, props.error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.hint ? (
        <p id={hintId} className="hint">
          {props.hint}
        </p>
      ) : null}
      <input
        id={id}
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        required={props.required ?? true}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
      {/*
        The live region is ALWAYS rendered. `role="alert"` announces changes to a live region,
        so a region that does not exist until there is an error to announce is frequently
        missed — the browser has nothing to observe. This is the single most common way a
        validation error becomes invisible to assistive technology.
      */}
      <p id={errorId} role="alert" className="error" aria-live="assertive">
        {props.error ?? ''}
      </p>
    </div>
  );
}

export interface AuthFormShellProps {
  readonly heading: string;
  readonly intro?: ReactNode;
  readonly children: ReactNode;
  /** The GENERIC response. Never a failure-specific message — see flow.ts. */
  readonly banner?: string | undefined;
  readonly bannerTone?: 'error' | 'info';
}

/**
 * The frame around every auth form.
 *
 * `bannerTone` is a presentational hint only. The banner text is decided by `flow.ts` and is
 * the same string whatever happened, so this component has no way to leak a failure kind even
 * if a future caller passes the wrong string — it renders whatever it is given, once, in one
 * place.
 */
export function AuthFormShell(props: AuthFormShellProps) {
  return (
    <main>
      <h1>{props.heading}</h1>
      {props.intro ? <p>{props.intro}</p> : null}
      {/*
        Same reasoning as the field error: the region is always present so the announcement is
        observed. `aria-live="polite"` because this is the FORM result, which a user may be
        reading past, rather than a validation error they must act on immediately.
      */}
      <div
        role={props.bannerTone === 'error' ? 'alert' : 'status'}
        aria-live={props.bannerTone === 'error' ? 'assertive' : 'polite'}
        className={`banner banner-${props.bannerTone ?? 'info'}`}
        // The test hook, and it exists because there are legitimately SEVERAL alert regions
        // on this page: one per field error, plus this form-level result. `getByRole('alert')`
        // is therefore ambiguous, and disambiguating it in the test by index or by text
        // matching would make the test assert something incidental. A named hook is more
        // honest and breaks loudly if the banner is renamed or removed.
        data-testid="auth-banner"
      >
        {props.banner ?? ''}
      </div>
      {props.children}
    </main>
  );
}

export interface SubmitButtonProps {
  readonly pending: boolean;
  readonly children: ReactNode;
}

/**
 * Never `disabled` while pending.
 *
 * A disabled submit button mid-request is invisible to a keyboard user, gives no explanation,
 * and in several screen readers is not focusable — so the form appears to have stopped
 * responding. The button is marked `aria-disabled` and stays focusable, and the request is
 * de-duplicated in the handler instead.
 */
export function SubmitButton(props: SubmitButtonProps) {
  return (
    <button type="submit" aria-disabled={props.pending} aria-busy={props.pending}>
      {props.children}
    </button>
  );
}

/** A link styled as a button, for "resend" style actions that navigate rather than submit. */
export function QuietLink(props: { href: string; children: ReactNode }) {
  return (
    <a href={props.href} className="quiet-link">
      {props.children}
    </a>
  );
}
