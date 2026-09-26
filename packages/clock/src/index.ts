/**
 * The single time source for the whole application.  (INV-TIME-1)
 *
 * Why this module exists
 * ----------------------
 * The exam model depends on a claim that is easy to state and easy to get wrong:
 * a student's deadline is decided by the SERVER, and a client whose system clock is
 * three days wrong must behave identically to a correct one.  That claim is only
 * enforceable if there is exactly one way to ask the time, and if that way can be
 * frozen in a test.
 *
 * So: no `Date.now()`, no `new Date()` for logic, and no `performance.now()` outside
 * this module.  The ESLint restriction in P0-T11 enforces it.  Everything else takes a
 * `Clock` by injection, which is why the entire deadline model is testable.
 *
 * Note the deliberate split from the database: Postgres supplies `now()` for row
 * defaults, and `C4` in plans/23-REVIEW-ACTIONS.md found that a web replica's in-process
 * clock and the database clock can disagree by seconds across replicas.  Deadline
 * *comparisons* are therefore evaluated in SQL against the primary; this module is for
 * application logic, display, and tests.
 */

/** A monotonic instant in milliseconds since the Unix epoch. */
export type Millis = number;

/** A duration in milliseconds. Durations and instants are deliberately different types. */
export type Duration = number;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): Millis;
  /**
   * A monotonic reading, unaffected by wall-clock adjustments. Use for measuring
   * elapsed time and durations; never for storing an instant.
   */
  monotonic(): number;
}

/**
 * The real clock. Spelled as an alias rather than `interface SystemClock extends Clock {}`,
 * which is an empty interface and means exactly the same thing while inviting structural
 * extension that would let a second clock claim to be the system clock.
 */
export type SystemClock = Clock;

/** The only implementation permitted to touch the host. */
export const systemClock: SystemClock = {
  now: () => Date.now(),
  // performance.now() is monotonic; fall back to Date.now() where it is absent.
  monotonic: () =>
    typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now(),
};

/**
 * A clock the test controls.
 *
 * `FrozenClock.now()` does not advance on its own — that is the point. A test that
 * needs elapsed time either calls `advance()` explicitly or uses `step()`, which is
 * what makes "the exam ended while the tab was closed" reproducible.
 */
export class FrozenClock implements Clock {
  #now: Millis;
  #monotonic = 0;

  constructor(start: Millis | Date = 0) {
    this.#now = typeof start === 'number' ? start : start.getTime();
  }

  now(): Millis {
    return this.#now;
  }

  monotonic(): number {
    return this.#monotonic;
  }

  /** Move the wall clock forward. Does not move the monotonic reading backwards. */
  advance(ms: Duration): this {
    this.#now += ms;
    this.#monotonic += ms;
    return this;
  }

  /** Move the wall clock backward. Models a student changing their system time. */
  rewind(ms: Duration): this {
    this.#now -= ms;
    return this;
  }

  /** Set the wall clock to an absolute instant. */
  set(at: Millis | Date): this {
    this.#now = typeof at === 'number' ? at : at.getTime();
    return this;
  }

  /** Restore the original instant. */
  reset(): this {
    this.#now = 0;
    this.#monotonic = 0;
    return this;
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Seconds to milliseconds, for policy fields that are authored in seconds. */
export const seconds = (n: number): Duration => n * SECOND;

/**
 * Clamp `value` into `[min, max]`. NaN maps to `min`, because a NaN deadline is the
 * one input that must never be allowed to propagate into a comparison.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Whole seconds remaining until `deadline`, never negative. */
export function secondsRemaining(deadline: Millis, now: Millis): number {
  return Math.max(0, Math.floor((deadline - now) / SECOND));
}

/** True once `now` has passed `deadline` plus `grace`. The single late-write predicate. */
export function isPastDeadline(deadline: Millis, now: Millis, grace: Duration = 0): boolean {
  return now > deadline + grace;
}

/**
 * The offset a client should apply to its own clock, from a server timestamp and a
 * round trip. Uses the RTT midpoint, so a slow response does not bias the estimate
 * in either direction. `C3`/`RN-10`: this is display-only; the server remains the
 * sole enforcer, so a wrong offset cannot extend or shorten an exam.
 */
export function clockOffset(serverNow: Millis, rttMs: number): Duration {
  return serverNow + rttMs / 2 - Date.now();
}

/**
 * Format an instant as an ISO-8601 UTC string.
 *
 * This exists because the INV-TIME-1 lint rule bans the `Date` constructor outright, and
 * `new Date(millis).toISOString()` is the only way most people would have produced a
 * timestamp. The rule caught exactly that in the healthz route during `next build`.
 *
 * The correct resolution is to close the gap in the module the rule points at, not to
 * weaken the rule or add an exception for `new Date(ms)`. A banned construct that
 * everyone needs a workaround for is a banned construct with a missing function.
 */
export function toIso(at: Millis): string {
  return new Date(at).toISOString();
}

/** The current instant as an ISO-8601 UTC string, via the injected clock. */
export const isoNow = (clock: Clock = systemClock): string => toIso(clock.now());

/** `m:ss` / `h:mm:ss`, for countdowns. Always non-negative. */
export function formatDuration(ms: Duration): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
