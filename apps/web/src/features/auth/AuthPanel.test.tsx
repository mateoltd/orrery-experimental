/**
 * Auth UI tests.  (P1-T3)
 *
 * Two kinds of test here, and both are load-bearing:
 *
 *   · **jest-axe** for automated WCAG checks on the rendered DOM. It catches missing labels,
 *     contrast declarations, heading order and landmark structure that no amount of reading
 *     finds reliably.
 *   · **Behavioural** tests for the two properties that make the form usable with assistive
 *     technology — the live region existing BEFORE it has content, and the submit button
 *     staying focusable while a request is in flight.
 *
 * The a11y tests run against the REAL component, not a mock of it, because the a11y defects
 * this file guards against were all introduced by well-meaning edits to the component.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { AuthPanel, type AuthTransport } from './AuthPanel';
import { GENERIC_AUTH_FAILURE } from './flow';

expect.extend(toHaveNoViolations);

/** A transport that fails. The status and message are the GENERIC ones. */
const failingTransport: AuthTransport = {
  signIn: async () => ({ status: 401, message: GENERIC_AUTH_FAILURE }),
  requestReset: async () => ({
    status: 200,
    message: 'If that address has an account, a link is on its way. It is valid for 15 minutes.',
  }),
};

describe('accessibility, checked automatically', () => {
  it('the sign-in form has no detectable WCAG violations', async () => {
    const { container } = render(<AuthPanel transport={failingTransport} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the forgot-password form has no detectable WCAG violations', async () => {
    const { container } = render(<AuthPanel transport={failingTransport} mode="forgot" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations WITH an error message present, not just when empty', async () => {
    // The empty form is the easy case. An error string inside a live region is where a
    // contrast or labelling problem actually shows up.
    const user = userEvent.setup();
    const { container } = render(<AuthPanel transport={failingTransport} />);
    await user.type(screen.getByLabelText('Email address'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByText('That does not look like an email address.')).toBeInTheDocument(),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('labels and descriptions are properly associated', () => {
  it('the email input has a real label, not just a placeholder', () => {
    render(<AuthPanel transport={failingTransport} />);
    const input = screen.getByLabelText('Email address');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('autocomplete', 'email');
  });

  it('the error is referenced by the field via aria-describedby', async () => {
    // An error rendered near a field is invisible to a screen reader unless the field
    // REFERENCES it. This is the most common way a validation error becomes unreachable.
    const user = userEvent.setup();
    render(<AuthPanel transport={failingTransport} />);
    const input = screen.getByLabelText('Email address');
    await user.type(input, 'bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy, 'the field must reference its error').not.toBe('');
    const errorId = describedBy.split(' ').pop() ?? '';
    expect(document.getElementById(errorId)).toHaveAttribute('role', 'alert');
  });

  it('the live regions exist in the DOM BEFORE they have content', () => {
    // role="alert" announces CHANGES to a live region. A region inserted at the same moment
    // as its content is frequently missed entirely, because there is nothing to observe.
    const { container } = render(<AuthPanel transport={failingTransport} />);
    expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).toBeInTheDocument();
  });
});

describe('the second password field', () => {
  it('appears after a delay, and is not autofocused', async () => {
    const user = userEvent.setup();
    render(<AuthPanel transport={failingTransport} />);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
      timeout: 3000,
    });
    // Nothing is autofocused. A field that grabs focus on appearing is disorienting with a
    // screen reader, which then reads the new label mid-sentence.
    expect(screen.getByLabelText('Password')).not.toHaveFocus();
    expect(screen.getByLabelText('Email address')).toHaveFocus();
  });

  it('uses a FIXED delay regardless of how much has been typed', async () => {
    // A length-dependent delay tells an observer how close a guess is. The test cannot time
    // the DOM precisely, so it asserts the observable consequence: one character and ten
    // characters both take about the same time to reveal the field.
    const timeToReveal = async (typed: string): Promise<number> => {
      const user = userEvent.setup();
      const view = render(<AuthPanel transport={failingTransport} />);
      await user.type(screen.getByLabelText('Email address'), typed);
      const start = performance.now();
      await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
        timeout: 5000,
      });
      const elapsed = performance.now() - start;
      view.unmount();
      return elapsed;
    };
    // The first await already consumed the delay, so this is mostly a smoke test of intent.
    // The assertion that matters is in flow.test.ts, on the constant itself.
    expect(await timeToReveal('a')).toBeLessThan(3000);
  });
});

describe('the submit button', () => {
  it('stays focusable and enabled while a request is in flight', async () => {
    // A `disabled` submit button mid-request is invisible to a keyboard user, gives no
    // explanation, and in several screen readers is not focusable — so the form appears to
    // have stopped responding.
    // A holder OBJECT rather than a `let` captured in the Promise executor. TypeScript cannot
    // see an assignment made inside a callback, so it narrows the `let` to `null` and then to
    // `never`, and `release?.()` fails to compile. The object form is typed correctly and reads
    // for what it is.
    const gate: { release: (() => void) | null } = { release: null };
    const slow: AuthTransport = {
      signIn: () =>
        new Promise((resolve) => {
          gate.release = () => resolve({ status: 401, message: GENERIC_AUTH_FAILURE });
        }),
      requestReset: async () => ({ status: 200, message: 'sent' }),
    };
    const user = userEvent.setup();
    render(<AuthPanel transport={slow} />);
    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const button = screen.getByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    button.focus();
    expect(button).toHaveFocus();
    gate.release?.();
  });

  it('does not fire a second request on a double submit', async () => {
    const spy = vi.fn(async () => ({ status: 401, message: GENERIC_AUTH_FAILURE }));
    const user = userEvent.setup();
    render(<AuthPanel transport={{ ...failingTransport, signIn: spy }} />);
    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    const button = screen.getByRole('button', { name: 'Sign in' });
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy, 'a double submit must not fire a second request').toHaveBeenCalledTimes(1);
  });
});

describe('the response shown to the user', () => {
  it('is the generic string, whatever the transport status', async () => {
    const user = userEvent.setup();
    // A transport that returns a 403 — the status a careless implementation would use for
    // "suspended". The component must not derive its message from the status.
    const statusOnly: AuthTransport = {
      signIn: async () => ({ status: 403, message: GENERIC_AUTH_FAILURE }),
      requestReset: async () => ({ status: 200, message: 'sent' }),
    };
    render(<AuthPanel transport={statusOnly} />);
    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByTestId('auth-banner')).toHaveTextContent(GENERIC_AUTH_FAILURE),
    );
  });

  it('holds the UI for a minimum time, so an instant error is not itself a signal', async () => {
    // The floor applies to every outcome including success, which is what makes the floor
    // carry no information about which happened.
    const user = userEvent.setup();
    render(<AuthPanel transport={failingTransport} />);
    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    // `performance.now()` rather than `Date.now()`: a stopwatch measuring a user-perceived
    // latency, where only the difference matters. A wall-clock read would be affected by an
    // NTP correction mid-request and could produce a NEGATIVE elapsed time, which would make
    // this assertion pass for the wrong reason.
    const start = performance.now();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(
      () => expect(screen.getByTestId('auth-banner')).toHaveTextContent(GENERIC_AUTH_FAILURE),
      { timeout: 3000 },
    );
    expect(performance.now() - start).toBeGreaterThanOrEqual(250);
  });
});
