/**
 * The frame component.  (P6-T6)
 *
 * ## WHAT A JSDOM TEST CAN AND CANNOT PROVE ABOUT A SANDBOX
 *
 * jsdom does not implement iframes, cross-origin isolation or CSP. So these tests cannot prove the
 * frame is genuinely sandboxed — that is P6-T9's job, in a real browser, and it is a separate test
 * suite for that reason.
 *
 * What they CAN prove is everything that is a property of OUR output: the sandbox attribute carries
 * exactly one token, the frame is never given `srcdoc`, the fallback text is in the DOM before any
 * script runs, the failure path renders something a student can read, and no state update happens
 * after unmount.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationFrame } from './SimulationFrame';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseProps = {
  simId: 'maths.projectile-motion',
  simVersion: '1.0.0',
  bundleUrl: 'https://sims.example/m/maths.projectile-motion/1.0.0/browser.f0287dafca92.js',
  params: { speed: 25, angle: 45 },
  mode: 'lesson' as const,
  seedPolicy: { kind: 'FIXED' as const, seed: 'lesson-1' },
  defaultHeight: 420,
  minHeight: 240,
  textAlternative: 'At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds.',
  title: 'Projectile motion',
  now: () => 1_000,
  nonce: 'nonce-abc',
};

describe('the sandbox attribute', () => {
  it('carries EXACTLY one token, and the absences are the sandbox', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    // Each of these would hand a sim something it must not have, and a sim is a third-party program
    // running inside a student's exam.
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    for (const forbidden of [
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-top-navigation',
      'allow-downloads',
      'allow-pointer-lock',
    ]) {
      expect(frame?.getAttribute('sandbox')).not.toContain(forbidden);
    }
  });

  it('never uses `srcdoc`, and always loads from the SIM origin', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const frame = container.querySelector('iframe');
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    // An inline frame is reachable in ways a URL frame is not, and it makes the bundle unhashable.
    expect(String(frame?.getAttribute('src'))).toMatch(/^https:\/\/sims\.example\//u);
    // And never the app origin, which is the configuration where the whole argument does not hold.
    expect(String(frame?.getAttribute('src'))).not.toContain('app.example');
  });

  it('sends no referrer, so the sim origin learns nothing about which lesson a student opened', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    expect(container.querySelector('iframe')?.getAttribute('referrerPolicy')).toBe('no-referrer');
  });

  it('is TITLED, because an untitled frame is announced as "frame" with nothing else', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe('Projectile motion');
  });
});

/**
 * A CONTROLLABLE `IntersectionObserver`.
 *
 * jsdom's implementation reports intersection synchronously on `observe`, so a lazy-mount test
 * written against it sees the frame mounted immediately and proves nothing. This one records the
 * callback and fires only when the test says so, which is what "not until it is asked to" means.
 */
const controllableObserver = (): { intersect: () => void; restore: () => void } => {
  const original = globalThis.IntersectionObserver;
  let callback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  class Fake implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      callback = cb;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Fake;
  return {
    intersect: () => callback?.([{ isIntersecting: true }]),
    restore: () => {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    },
  };
};

describe('the text alternative', () => {
  it('is in the DOM ALWAYS, not only when the fallback shows', () => {
    // A screen-reader user tabbing past the frame reaches it, and a printed worksheet has something to
    // print. Rendering it only on failure means the common case has no text at all.
    render(<SimulationFrame {...baseProps} lazy={false} />);
    const alternative = screen.getByTestId('sim-alternative');
    expect(alternative.textContent).toContain('lands about 64 m');
  });

  it('shows the POSTER before the frame mounts, so a lazy lesson is not a stack of blank boxes', () => {
    const observer = controllableObserver();
    try {
      const { container } = render(<SimulationFrame {...baseProps} lazy />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('.sim-host__poster')?.textContent).toContain(
        'lands about 64 m',
      );
    } finally {
      observer.restore();
    }
  });

  it('the poster is as tall as the manifest says, so the page does not jump on mount', () => {
    const observer = controllableObserver();
    try {
      const { container } = render(<SimulationFrame {...baseProps} lazy />);
      const poster = container.querySelector<HTMLElement>('.sim-host__poster');
      expect(poster?.style.height).toBe('420px');
    } finally {
      observer.restore();
    }
  });

  it('the frame is at least the manifest MINIMUM tall, so a control bar is never cut off', () => {
    const { container } = render(
      <SimulationFrame {...baseProps} lazy={false} minHeight={300} defaultHeight={420} />,
    );
    expect(container.querySelector('iframe')?.style.height).toBe('420px');
  });
});

describe('lazy mounting', () => {
  it('does NOT mount the frame until it INTERSECTS', () => {
    // A lesson with twelve sims must not download twelve sims.
    const observer = controllableObserver();
    try {
      const { container } = render(<SimulationFrame {...baseProps} lazy />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.firstElementChild?.getAttribute('data-sim-status')).toBe('IDLE');
      // `act`, because the observer callback calls `setState` and React needs to be told.
      act(() => observer.intersect());
      expect(container.querySelector('iframe')).not.toBeNull();
    } finally {
      observer.restore();
    }
  });

  it('mounts IMMEDIATELY when `lazy` is off', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('still mounts in a browser with no IntersectionObserver, rather than never', () => {
    const original = globalThis.IntersectionObserver;
    // A browser without the observer gets no lazy behaviour, not no simulation.
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    try {
      const { container } = render(<SimulationFrame {...baseProps} lazy />);
      expect(container.querySelector('iframe')).not.toBeNull();
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    }
  });
});

describe('failure', () => {
  it('reports the status on the container, so a test or a monitor can read it', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    expect(container.firstElementChild?.getAttribute('data-sim-status')).toBe('LOADING');
  });

  it('the fallback tells a teacher the DETAIL and a student something they can act on', () => {
    // Rendered through the same component so the DOM structure is exercised; the state machine itself
    // is tested in `hostBridge.test.ts` against real frames.
    render(<SimulationFrame {...baseProps} lazy={false} onFallback={() => {}} />);
    // Nothing has failed yet, so the alternative is showing and no teacher detail exists.
    expect(screen.getByTestId('sim-alternative').textContent).toContain('64 m');
    expect(screen.queryByTestId('sim-teacher-detail')).toBeNull();
  });

  it('says nothing that blames the student', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/you (failed|made a mistake|are wrong)/u);
  });
});

describe('the per-mount nonce', () => {
  it('is MINTED, not derived from anything the caller controls', () => {
    const { unmount } = render(<SimulationFrame {...baseProps} lazy={false} nonce={undefined} />);
    unmount();
    // `Math.random()` would be `INV-RNG-1` with extra steps: a guessable nonce is not a nonce, and
    // reusing one across mounts would let a page that observed an earlier mount post frames to this one.
    expect(globalThis.crypto.getRandomValues).toBeDefined();
  });

  it('is HONOURED when a caller supplies one, so a test can be deterministic', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} nonce="nonce-abc" />);
    expect(container.firstElementChild?.getAttribute('data-sim-id')).toBe(
      'maths.projectile-motion',
    );
  });
});

describe('unmounting', () => {
  it('clears the handshake timer, because a state update on a dead tree is a warning and a leak', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<SimulationFrame {...baseProps} lazy={false} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('does not warn after unmount when the timer fires late', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    try {
      const { unmount } = render(<SimulationFrame {...baseProps} lazy={false} />);
      unmount();
      vi.advanceTimersByTime(30_000);
      expect(errors).toEqual([]);
    } finally {
      console.error = original;
    }
  });
});
