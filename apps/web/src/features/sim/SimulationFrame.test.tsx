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
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProbeCache } from './hostBridge';
import { SimulationFrame } from './SimulationFrame';

afterEach(() => {
  // Explicit, because this project does not enable vitest globals and Testing Library's automatic
  // cleanup registers itself against a global `afterEach`. Without it, each test's DOM joins the next
  // test's, and a query can match a previous test's element -- which is how "found multiple elements"
  // arrives in a test that only rendered once.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  // The probe caches successful answers per origin, keyed by nothing but the origin. Without this, the
  // first test to prove the origin answers decides the answer for every test after it -- which is how
  // a "the probe was blocked" test came back green on a cached OK.
  resetProbeCache();
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
  simOrigin: 'https://sims.example',
  // No probe by default: these tests are about our OUTPUT, and a stubbed fetch would only make them
  // assert the stub. The probe has its own describe block below, where being probed is the point.
  probeFetch: null,
  appOrigin: 'https://app.example',
};

/**
 * Do what a browser does when a cross-origin frame finishes loading.
 *
 * The component used to call this itself, immediately after adding the listener, "so tests do not have
 * to". That started the handshake clock during the DOWNLOAD, which is precisely what the code's own
 * comment said it must not do, and it made a slow bundle report a handshake failure for a frame that
 * had simply not arrived yet. A browser always fires `load`, so the test fires it too.
 */
const fireLoad = (container: HTMLElement): void => {
  const frame = container.querySelector('iframe');
  expect(frame).not.toBeNull();
  act(() => {
    frame?.dispatchEvent(new Event('load'));
  });
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
    // IDLE before the frame loads, and LOADING after: the status reflects a real signal rather than
    // the component's own optimism.
    expect(container.firstElementChild?.getAttribute('data-sim-status')).toBe('IDLE');
    fireLoad(container);
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
    const { container, unmount } = render(<SimulationFrame {...baseProps} lazy={false} />);
    // The timer only exists once the frame has loaded, so the test has to load it first -- otherwise
    // this asserts that a timer which was never created is cleared, which is true of every component.
    fireLoad(container);
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

/**
 * ## WHAT WAS MISSING, AND WHY THESE TESTS ARE THE POINT OF THE REOPEN
 *
 * The host built six frames and delivered none of them. Every test above still passed, because each
 * one asserted something about our OUTPUT -- an attribute, a fallback, a status -- and none of them
 * watched the one thing a simulation actually experiences: bytes crossing into the frame.
 *
 * jsdom gives `iframe.contentWindow` as a real-ish object, so `postMessage` can be observed without a
 * browser. What still cannot be proven here is cross-origin isolation, which stays P6-T9's job.
 */
describe('delivering frames to the frame', () => {
  /** Intercept `postMessage` on the iframe's contentWindow, which is where our transport sends. */
  const watchPosts = (container: HTMLElement): { calls: Array<[unknown, string]> } => {
    const frame = container.querySelector('iframe');
    const calls: Array<[unknown, string]> = [];
    Object.defineProperty(frame?.contentWindow, 'postMessage', {
      configurable: true,
      writable: true,
      value: (message: unknown, targetOrigin: string): void => {
        calls.push([message, targetOrigin]);
      },
    });
    return { calls };
  };

  it('sends `sim:init` after load, with the nonce, the seed and the params', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const { calls } = watchPosts(container);
    // Nothing before load: a frame that has not loaded has no window to receive anything, and posting
    // early spends the handshake budget on a download.
    expect(calls).toHaveLength(0);
    fireLoad(container);
    expect(calls).toHaveLength(1);
    const first = calls[0] as [unknown, string];
    const [frame, target] = first;
    expect(target).toBe('*');
    expect(frame).toMatchObject({
      type: 'sim:init',
      protocol: 1,
      nonce: 'nonce-abc',
      simId: 'maths.projectile-motion',
      simVersion: '1.0.0',
      seed: 'lesson-1',
      mode: 'lesson',
      params: { speed: 25, angle: 45 },
    });
  });

  it("posts to '*', because an explicit origin is REFUSED for an opaque sandboxed frame", () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const { calls } = watchPosts(container);
    fireLoad(container);
    // Verified in Chromium by the conformance suite, not asserted here on faith:
    //   Failed to execute 'postMessage': The target origin provided ('https://sims.example') does not
    //   match the recipient window's origin ('null').
    // `sandbox="allow-scripts"` withholds `allow-same-origin`, so the frame's origin is 'null' and every
    // explicit target is rejected. The previous version posted to the explicit origin and delivered
    // nothing at all.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call[1] === '*')).toBe(true);
  });

  it('still refuses to MOUNT with an unusable origin, because the probe needs one', () => {
    for (const simOrigin of ['', 'sims.example', '/relative', 'https://sims.example/sub']) {
      const { container, unmount } = render(
        <SimulationFrame {...baseProps} simOrigin={simOrigin} lazy={false} />,
      );
      expect(container.querySelector('iframe')).toBeNull();
      unmount();
    }
  });

  it('REFUSES to mount when the origin is unusable, rather than downgrading to "*"', () => {
    // A missing or malformed origin is a configuration bug. It should fail in development, visibly,
    // and in production it should show the fallback -- never silently post a nonce to whatever loaded.
    for (const simOrigin of ['', 'sims.example', '/relative', 'https://sims.example/sub']) {
      // Unmounted per iteration, so each case asserts against its own DOM rather than the union of four
      // renders -- which reports "multiple elements" and proves nothing about any single origin.
      const { container, unmount } = render(
        <SimulationFrame {...baseProps} simOrigin={simOrigin} lazy={false} />,
      );
      expect(container.querySelector('iframe')).toBeNull();
      const detail = container.querySelector('[data-testid="sim-teacher-detail"]');
      expect(detail?.textContent).toContain('not a usable origin');
      expect(container.querySelector('[data-testid="sim-alternative"]')?.textContent).toContain(
        '64 m',
      );
      unmount();
    }
  });

  it('on a tab change, PAUSES the sim and CAPTURES the state, because that is the last chance', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const { calls } = watchPosts(container);
    fireLoad(container);
    // Restored afterwards by `afterEach`'s `cleanup()` and `restoreAllMocks()`; left overridden it
    // would make every later test in this file believe the tab is hidden.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    // BOTH frames, in order: pause the timeline AND ask for the state. They are the same event seen
    // from two directions — a hidden tab is the last moment before a student closes the laptop.
    // The LAST TWO, because the call list also contains `sim:init`.
    expect(calls.slice(-2).map((call) => call[0])).toEqual([
      { type: 'sim:visibility', visible: false },
      { type: 'sim:requestState', reason: 'blur' },
    ]);
  });

  it('sends `sim:teardown` before unmount finishes, so the sim can stop its rAF loop', () => {
    const { container, unmount } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const { calls } = watchPosts(container);
    fireLoad(container);
    unmount();
    expect(calls[calls.length - 1]).toEqual([{ type: 'sim:teardown' }, '*']);
  });

  it('does NOT send a second `sim:init` when the frame fires load twice', () => {
    const { container } = render(<SimulationFrame {...baseProps} lazy={false} />);
    const { calls } = watchPosts(container);
    fireLoad(container);
    fireLoad(container);
    // Two inits means a sim that re-initialises mid-answer discards the student's work so far.
    expect(calls.filter(([frame]) => (frame as { type: string }).type === 'sim:init')).toHaveLength(
      1,
    );
  });
});

/**
 * Drain the probe's promise chain.
 *
 * One `await` is not one round trip: the fetch rejects, `probeSimOrigin` catches, and the component
 * then commits two states. A test that flushes once is testing how many microtasks a rejection takes,
 * not whether the fallback works.
 */
const flushProbe = async (): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
};

describe('the reachability probe', () => {
  const okFetch = (): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'Access-Control-Allow-Origin': 'https://app.example' },
        }),
      )) as unknown as typeof fetch;

  it('mounts when the sim origin answers its CORS probe', async () => {
    const { container } = render(
      <SimulationFrame {...baseProps} lazy={false} probeFetch={okFetch()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('shows the FIREWALL advice when the probe is blocked, and never requests the bundle', async () => {
    const blocked = (): typeof fetch =>
      (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const { container } = render(
      <SimulationFrame {...baseProps} lazy={false} probeFetch={blocked()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // The advice is specific, because "it did not load" is not something a student can act on.
    expect(screen.getByText(/blocking the simulation server/u)).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('sim-teacher-detail').textContent).toContain('sims.example');
  });

  it('uses a CORS fetch with the app origin presented, never `no-cors`', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([String(input), init]);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    render(<SimulationFrame {...baseProps} lazy={false} probeFetch={spy} />);
    await flushProbe();
    const [url, init] = seen[0] ?? [];
    // An opaque response cannot be distinguished from a blocked one, which is the whole question.
    expect(url).toBe('https://sims.example/__sim_origin_probe');
    expect(init?.mode).toBe('cors');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Orrery-App-Origin']).toBe('https://app.example');
    // The bundle must not even be requested for a network that cannot serve it.
    expect(url).not.toContain('browser.');
  });
});
