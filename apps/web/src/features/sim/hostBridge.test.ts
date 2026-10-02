/**
 * The host bridge, and the frame's own guarantees.  (P6-T6)
 *
 * ## THE TESTS THAT MATTER MOST
 *
 *  - `a frame from the WRONG SOURCE is dropped, and counted as a spoof attempt` — a sim can create its
 *    own iframe, and a nested frame has a different `event.source`. Checking only the nonce would accept
 *    a frame we did not mount, and the nonce is not secret to a frame that legitimately holds it.
 *  - `the nonce is checked BEFORE the frame type is even read` — an unauthenticated frame's contents are
 *    attacker input, and the test proves it by making the type a getter that throws if touched.
 *  - `the clock really can fire` — the first version of `checkTimeout` compared `now()` against an
 *    arithmetic expression built out of `defaultHeight`, which is not a timestamp. It could never fire,
 *    and the original test passed because it only asserted on the returned state.
 *  - `a flush with nothing pending changes NOTHING` — the first flush sent a synthetic
 *    `{width: 0, height: 0}`, so unmounting any sim collapsed it to its minimum height.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_ADVICE,
  type BlockedReason,
  classifyProbe,
  createHostBridge,
  deriveSeed,
  type HostInput,
  isBlockedReason,
  PROBE_CACHE_TTL_MS,
  probeAllowsMount,
  probeSimOrigin,
  resetProbeCache,
  SIM_ORIGIN_PROBE_PATH,
  STUDENT_MESSAGES,
} from './hostBridge';

const FRAME = { name: 'the-frame' } as unknown as Window;
const OTHER = { name: 'a-nested-frame' } as unknown as Window;

const baseInput = (over: Partial<HostInput> = {}): HostInput => ({
  simId: 'maths.projectile-motion',
  simVersion: '1.0.0',
  nonce: 'nonce-abc',
  mode: 'lesson',
  params: { speed: 25, angle: 45 },
  seed: 'seed-1',
  seedPolicy: { kind: 'FIXED', seed: 'seed-1' },
  gradingSupplied: false,
  bundleUrl: 'https://sims.example/m/maths.projectile-motion/1.0.0/browser.f0287dafca92.js',
  defaultHeight: 420,
  minHeight: 240,
  now: () => 1_000,
  transport: { subscribe: () => () => {} },
  expectedSource: FRAME,
  ...over,
});

const ready = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'sim:ready',
  nonce: 'nonce-abc',
  protocol: 1,
  simId: 'maths.projectile-motion',
  simVersion: '1.0.0',
  capabilities: {
    state: true,
    grading: true,
    randomised: false,
    audio: false,
    webgl: false,
    stepper: true,
    scenarios: [],
  },
  exports: ['simulate', 'grade'],
  ...over,
});

describe('authenticating an inbound frame', () => {
  it('accepts a frame with the right nonce FROM THE MOUNTED FRAME', () => {
    const bridge = createHostBridge(baseInput({ expectedSource: FRAME }));
    const state = bridge.receive(ready(), FRAME);
    expect(state.status).toBe('READY');
    expect(state.framesAccepted).toBe(1);
  });

  it('a frame from the WRONG SOURCE is dropped and counted as a SPOOF attempt', () => {
    const bridge = createHostBridge(baseInput({ expectedSource: FRAME }));
    const state = bridge.receive(ready(), OTHER);
    expect(state.status).not.toBe('READY');
    expect(state.spoofAttempts).toBe(1);
    expect(state.framesAccepted).toBe(0);
  });

  it('a WRONG nonce is dropped even from the right source', () => {
    const bridge = createHostBridge(baseInput());
    const state = bridge.receive(ready({ nonce: 'guess' }), FRAME);
    expect(state.status).not.toBe('READY');
    expect(state.framesDropped).toBe(1);
    // And it is NOT counted as a spoof: a spoof is a source problem, and conflating the two makes both
    // numbers useless in a support conversation.
    expect(state.spoofAttempts).toBe(0);
  });

  it('the nonce is checked BEFORE the frame type is even READ', () => {
    const bridge = createHostBridge(baseInput());
    let touched = false;
    const hostile = {
      get type(): string {
        touched = true;
        return 'sim:answer';
      },
      nonce: 'wrong',
    };
    bridge.receive(hostile, FRAME);
    expect(touched, 'the frame type was read before authentication').toBe(false);
    expect(bridge.get().framesDropped).toBe(1);
  });

  it('an UNKNOWN frame type is IGNORED, not fatal — a newer sim degrades', () => {
    // `plans/10` §2.3 rule 2. Treating it as an error would make every protocol addition a breaking
    // change for every deployed host.
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    const state = bridge.receive({ type: 'sim:somethingNew', nonce: 'nonce-abc' }, FRAME);
    expect(state.status).toBe('READY');
    expect(state.showFallback).toBe(false);
    // Authenticated, so NOT dropped, and counted separately: a rising `ignored` count on one sim is how
    // a host learns it needs updating.
    expect(state.framesAccepted).toBe(2);
    expect(state.framesDropped).toBe(0);
    expect(state.framesIgnored).toBe(1);
  });

  it('counters are refreshed by EVERY frame, so a counter is never stale in a screenshot', () => {
    // They were stamped onto the state only inside the `sim:ready` branch, so an incident that happened
    // ten frames later reported the numbers from ten frames earlier.
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    const state = bridge.receive({ type: 'sim:somethingNew', nonce: 'nonce-abc' }, FRAME);
    expect(state.framesAccepted).toBe(2);
    expect(state.framesIgnored).toBe(1);
  });

  it('counters are reported, so a support question has NUMBERS in it', () => {
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    bridge.receive({ type: 'sim:answer', nonce: 'bad' }, FRAME);
    bridge.receive(ready(), OTHER);
    const state = bridge.get();
    expect(state.framesAccepted).toBe(1);
    expect(state.framesDropped).toBe(1);
    expect(state.spoofAttempts).toBe(1);
  });
});

describe('the handshake', () => {
  it('a VERSION mismatch DEGRADES with a panel, and the lesson keeps working', () => {
    const bridge = createHostBridge(baseInput());
    const state = bridge.receive(ready({ simVersion: '2.0.0' }), FRAME);
    expect(state.status).toBe('DEGRADED');
    expect(state.showFallback).toBe(true);
    expect(state.studentMessage).toBe(STUDENT_MESSAGES.DEGRADED);
    // The message names BOTH versions, because "it did not work" is not something a teacher can act on.
    expect(state.teacherDetail).toContain('2.0.0');
    expect(state.teacherDetail).toContain('1.0.0');
  });

  it('a PROTOCOL mismatch FAILS, because the frames would mean different things', () => {
    const bridge = createHostBridge(baseInput());
    expect(bridge.receive(ready({ protocol: 99 }), FRAME).status).toBe('FAILED');
  });

  it('a sim that CLAIMS a different id FAILS', () => {
    const bridge = createHostBridge(baseInput());
    expect(bridge.receive(ready({ simId: 'physics.pendulum' }), FRAME).status).toBe('FAILED');
  });

  it('capabilities reach the host, because it plans around them', () => {
    const bridge = createHostBridge(baseInput());
    const state = bridge.receive(ready(), FRAME);
    expect(state.capabilities).toEqual({ state: true, grading: true, stepper: true });
  });

  it('does NOT refuse a LESSON mount whose sim can grade', () => {
    // The protocol check was originally backwards and refused exactly this, which would have blocked
    // every lesson embed of a simulation a student may later be examined on.
    expect(createHostBridge(baseInput()).receive(ready(), FRAME).status).toBe('READY');
  });

  it('the init frame carries the NONCE and the mode, and grading only when supplied', () => {
    const lesson = createHostBridge(baseInput()).initFrame();
    expect(lesson.type).toBe('sim:init');
    // Narrowed first: `HostFrame` is the union, and reading `.nonce` off it is a type error rather
    // than a runtime one, which is the point of modelling the frames as a union.
    const init = lesson as Extract<typeof lesson, { type: 'sim:init' }>;
    expect(init.nonce).toBe('nonce-abc');
    expect(init.mode).toBe('lesson');
    // No grading block in a lesson mount, so a sim that grades has nothing to score and must be refused.
    expect((lesson as { grading?: unknown }).grading).toBeUndefined();

    const graded = createHostBridge(
      baseInput({ mode: 'graded', gradingSupplied: true }),
    ).initFrame();
    expect((graded as { grading?: unknown }).grading).toBeDefined();
  });
});

describe('the handshake timeout', () => {
  it('the clock starts at the LOAD EVENT, and the bridge never records a mount time at all', () => {
    // A bundle that takes nine seconds to download has not spent nine seconds failing to hand-shake, so
    // the timer begins when the frame ELEMENT reports a load and not when the component mounted.
    //
    // The first version of this test set the clock to 9_000 BEFORE calling `onFrameEvent('load')`, so
    // the load happened at t=9000 and the timeout at t=10001 was only one second later — the
    // arithmetic contradicted the comment sitting directly above it.
    let clock = 0;
    const bridge = createHostBridge(baseInput({ now: () => clock }));
    expect(bridge.checkTimeout()).toBeNull();
    expect(bridge.onFrameEvent('load').status).toBe('LOADING');
    clock = 9_999;
    expect(bridge.checkTimeout()).toBeNull();
    clock = 10_001;
    expect(bridge.checkTimeout()?.status).toBe('TIMED_OUT');
  });

  it('the clock really CAN fire, which the first version of this test never checked', () => {
    let clock = 0;
    const bridge = createHostBridge(baseInput({ now: () => clock }));
    bridge.onFrameEvent('load');
    for (let i = 0; i < 9_999; i += 1) {
      clock = i;
      expect(bridge.checkTimeout(), `fired early at ${String(i)} ms`).toBeNull();
    }
    clock = 10_001;
    expect(bridge.checkTimeout()?.status).toBe('TIMED_OUT');
  });

  it('does NOT fire before the frame loads, because that failure is UNREACHABLE instead', () => {
    // Telling a teacher to reload a page that fails identically is worse than telling them to check
    // their firewall.
    const bridge = createHostBridge(baseInput({ now: () => 60_000 }));
    expect(bridge.checkTimeout()).toBeNull();
    expect(bridge.onFrameEvent('error').status).toBe('UNREACHABLE');
    expect(bridge.checkTimeout()).toBeNull();
  });

  it('does not fire once the sim is READY', () => {
    let clock = 0;
    const bridge = createHostBridge(baseInput({ now: () => clock }));
    bridge.onFrameEvent('load');
    clock = 30_000;
    bridge.receive(ready(), FRAME);
    expect(bridge.checkTimeout()).toBeNull();
    expect(bridge.get().status).toBe('READY');
  });

  it('a TIMED_OUT mount and an UNREACHABLE mount give the STUDENT different sentences', () => {
    // They have different causes and different remedies, and one sentence for both would send a
    // teacher to the wrong place.
    expect(STUDENT_MESSAGES.TIMED_OUT).not.toBe(STUDENT_MESSAGES.UNREACHABLE);
    expect(STUDENT_MESSAGES.TIMED_OUT).toMatch(/did not start in time/u);
    expect(STUDENT_MESSAGES.UNREACHABLE).toMatch(/could not be loaded/u);
  });
});

describe('resize', () => {
  it('delivers the FIRST resize at once, so a sim never opens with a blank frame', () => {
    // Trailing-only would add the debounce window to every sim on every page load, which is the one
    // moment a student is definitely watching.
    const bridge = createHostBridge(baseInput());
    bridge.applyResize({ width: 800, height: 500 });
    expect(bridge.get().height).toBe(500);
  });

  it('coalesces the SETTLE, so a repainting frame does not relayout the lesson 60 times a second', () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const bridge = createHostBridge(baseInput({ now: () => clock }));
      bridge.applyResize({ width: 800, height: 500 });
      clock = 10;
      bridge.applyResize({ width: 800, height: 560 });
      clock = 20;
      bridge.applyResize({ width: 800, height: 640 });
      // Still 500: two more arrived inside the window and collapse into one trailing delivery.
      expect(bridge.get().height).toBe(500);
      vi.advanceTimersByTime(200);
      expect(bridge.get().height).toBe(640);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a flush with nothing pending changes NOTHING, rather than collapsing the frame', () => {
    const bridge = createHostBridge(baseInput({ minHeight: 240, defaultHeight: 420 }));
    expect(bridge.onFrameEvent('load').height).toBe(420);
    bridge.flushResize();
    expect(bridge.get().height).toBe(420);
  });

  it('honours the manifest MINIMUM, so a control bar is never cut off', () => {
    const bridge = createHostBridge(baseInput({ minHeight: 240, defaultHeight: 420 }));
    bridge.onFrameEvent('load');
    // A sim reporting 10 px tall is either not laid out or collapsed; the floor is honoured.
    bridge.applyResize({ width: 800, height: 10 });
    bridge.flushResize();
    expect(bridge.get().height).toBe(240);
  });

  it('the default height is used BEFORE the frame has reported anything', () => {
    const bridge = createHostBridge(baseInput({ defaultHeight: 500 }));
    expect(bridge.onFrameEvent('load').height).toBe(500);
  });
});

describe('gradePreview during a graded mount', () => {
  it('is DISCARDED and recorded, because a sim declaring its own grade is worth a ticket', () => {
    const bridge = createHostBridge(baseInput({ mode: 'graded', gradingSupplied: true }));
    bridge.receive(ready(), FRAME);
    const state = bridge.receive(
      {
        type: 'sim:gradePreview',
        nonce: 'nonce-abc',
        points: 4,
        correct: true,
        rationale: '4/4',
        surface: 'student',
      },
      FRAME,
    );
    // No `answer` is derived from it, and the mount does not become a graded one.
    expect(state.answer).toBeNull();
    expect(state.status).toBe('READY');
    expect(state.teacherDetail).toMatch(/gradePreview during a graded mount/u);
  });
});

describe('a sim error', () => {
  it('GRADER_FAILED is fatal even though the frame marked it recoverable', () => {
    // A wrong grade is worse than no grade, and a sim cannot be trusted to know which it is in.
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    const state = bridge.receive(
      {
        type: 'sim:error',
        nonce: 'nonce-abc',
        code: 'GRADER_FAILED',
        message: 'boom',
        recoverable: true,
      },
      FRAME,
    );
    expect(state.status).toBe('FAILED');
    expect(state.showFallback).toBe(true);
  });

  it('a RECOVERABLE error is recorded without tearing the frame down', () => {
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    const state = bridge.receive(
      {
        type: 'sim:error',
        nonce: 'nonce-abc',
        code: 'RENDER_FAILED',
        message: 'one frame',
        recoverable: true,
      },
      FRAME,
    );
    expect(state.status).toBe('READY');
    expect(state.teacherDetail).toContain('RENDER_FAILED');
  });
});

describe('state and answer capture', () => {
  it('an answer is captured, and an unsolicited state is kept', () => {
    const bridge = createHostBridge(baseInput());
    bridge.receive(ready(), FRAME);
    expect(
      bridge.receive({ type: 'sim:answer', nonce: 'nonce-abc', answer: { range: 63.7 } }, FRAME)
        .answer,
    ).toEqual({
      range: 63.7,
    });
    expect(
      bridge.receive(
        { type: 'sim:state', nonce: 'nonce-abc', state: { t: 1.2 }, checksum: '' },
        FRAME,
      ).lastState,
    ).toEqual({
      t: 1.2,
    });
  });

  it('the host can ASK for state, and names WHY', () => {
    const bridge = createHostBridge(baseInput());
    // `reason` is a closed set because "why did we save at that moment" is a support question.
    for (const reason of ['save', 'submit', 'blur', 'unload', 'replay', 'resize'] as const) {
      expect(bridge.requestState(reason)).toEqual({ type: 'sim:requestState', reason });
    }
  });

  it('visibility and teardown are ordinary frames', () => {
    const bridge = createHostBridge(baseInput());
    expect(bridge.visibility(false)).toEqual({ type: 'sim:visibility', visible: false });
    expect(bridge.teardown()).toEqual({ type: 'sim:teardown' });
    expect(bridge.command('step', { steps: 600 })).toEqual({
      type: 'sim:command',
      name: 'step',
      args: { steps: 600 },
    });
  });
});

describe('seed derivation', () => {
  it('FIXED returns the seed, and PER_VIEW asks for a fresh one each time', () => {
    expect(deriveSeed({ kind: 'FIXED', seed: 'abc' }, {}, () => 'fresh')).toBe('abc');
    let calls = 0;
    const random = (): string => {
      calls += 1;
      return `fresh-${String(calls)}`;
    };
    // Fresh every load is what discourages screenshot-sharing: a screenshot is evidence of one view.
    expect(deriveSeed({ kind: 'PER_VIEW' }, {}, random)).toBe('fresh-1');
    expect(deriveSeed({ kind: 'PER_VIEW' }, {}, random)).toBe('fresh-2');
  });

  it('PER_STUDENT is STABLE, so a re-sit gives the same paper', () => {
    const policy = { kind: 'PER_STUDENT', derivation: 'ATTEMPT_ID' } as const;
    const first = deriveSeed(policy, { attemptId: 'attempt-42' }, () => 'unused');
    const second = deriveSeed(policy, { attemptId: 'attempt-42' }, () => 'unused');
    expect(first).toBe(second);
    // A `random()` would have satisfied "different each call" and broken reproducibility entirely.
  });

  it('PER_STUDENT HASHES the identity, so adjacent ids give UNRELATED papers', () => {
    // A raw attempt id in a sim's PRNG is predictable to anyone holding a gradebook, and adjacent ids
    // in a seeded PRNG produce adjacent draws — two students whose papers differ in one place.
    const policy = { kind: 'PER_STUDENT', derivation: 'ATTEMPT_ID' } as const;
    const a = deriveSeed(policy, { attemptId: 'attempt-1' }, () => 'x');
    const b = deriveSeed(policy, { attemptId: 'attempt-2' }, () => 'x');
    expect(a).not.toBe(b);
    // And neither leaks the id.
    expect(a).not.toContain('attempt');
    expect(a).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('a MISSING identity THROWS rather than falling back, because a fallback is a SHARED paper', () => {
    // Every student in a cohort seeing the same exam is the failure nobody notices until the results
    // come in.
    expect(() =>
      deriveSeed({ kind: 'PER_STUDENT', derivation: 'ATTEMPT_ID' }, {}, () => 'x'),
    ).toThrow(/SEED_IDENTITY_MISSING/u);
  });

  it('the three derivations are DISTINCT, so a user seed and an assignment seed differ', () => {
    expect(
      deriveSeed({ kind: 'PER_STUDENT', derivation: 'USER_ID' }, { userId: 'x' }, () => 'y'),
    ).not.toBe(
      deriveSeed(
        { kind: 'PER_STUDENT', derivation: 'ASSIGNMENT_ID' },
        { assignmentId: 'x' },
        () => 'y',
      ),
    );
  });
});

describe('the blocked-reason vocabulary', () => {
  it('has ADVICE for every reason, because "it did not load" is not actionable', () => {
    for (const reason of ['FIREWALL', 'OFFLINE', 'DNS', 'UNKNOWN'] as BlockedReason[]) {
      expect(isBlockedReason(reason)).toBe(true);
      expect(BLOCKED_ADVICE[reason].length).toBeGreaterThan(30);
    }
    expect(isBlockedReason('SOMETHING')).toBe(false);
    // A firewall and a DNS failure send a teacher to different places, so the sentences differ.
    expect(BLOCKED_ADVICE.FIREWALL).not.toBe(BLOCKED_ADVICE.DNS);
  });

  it('none of them blames the student', () => {
    for (const advice of Object.values(BLOCKED_ADVICE)) {
      expect(advice).not.toMatch(/you (failed|made a mistake|got it wrong|are wrong)/u);
    }
    // And the firewall one says so outright, because "not your fault" is the point.
    expect(BLOCKED_ADVICE.FIREWALL).toMatch(/Nothing is wrong with your work/u);
  });
});

/**
 * The reachability probe.  (P6-T6)
 *
 * ## WHY `classifyProbe` IS TESTED SEPARATELY FROM `probeSimOrigin`
 *
 * The interesting question is not "does a rejected fetch produce a non-OK outcome" but "does it produce
 * the RIGHT non-OK outcome". Reporting OFFLINE for a firewall sends a student to check a cable that is
 * plugged in, so the classifier gets its own cases rather than being inferred from the fetcher.
 */
describe('classifying a probe failure', () => {
  it('reports OFFLINE only when the browser itself says there is no network', () => {
    expect(classifyProbe(new TypeError('Failed to fetch'), 0, false).outcome).toBe('OFFLINE');
  });

  it('reports FIREWALL for everything else, because every other failure looks the same', () => {
    // A 502, a dropped packet and a blocked request all reject identically. Only the browser's own
    // opinion distinguishes them, and it is the only trustworthy one.
    for (const error of [new TypeError('Failed to fetch'), new Error('network error'), undefined]) {
      expect(classifyProbe(error, 0, true).outcome).toBe('FIREWALL');
    }
  });

  it('keeps the underlying message for the teacher line, and it is a string', () => {
    const result = classifyProbe(new TypeError('Failed to fetch'), 0, true);
    expect(result.detail).toBe('Failed to fetch');
    expect(typeof result.detail).toBe('string');
  });

  it('has an advice entry for every outcome it can produce', () => {
    // "It did not load" is not something a student can act on, so each outcome names its own next step.
    for (const outcome of ['FIREWALL', 'OFFLINE', 'DNS'] as const) {
      expect(BLOCKED_ADVICE[outcome].length).toBeGreaterThan(20);
      expect(isBlockedReason(outcome)).toBe(true);
    }
    expect(probeAllowsMount({ outcome: 'OK', detail: '', status: 200 })).toBe(true);
    expect(probeAllowsMount({ outcome: 'FIREWALL', detail: '', status: 0 })).toBe(false);
    // Not having asked is not the same as having been told no.
    expect(probeAllowsMount(null)).toBe(true);
  });
});

describe('probing the sim origin', () => {
  const respond = (status: number): typeof fetch =>
    (() => Promise.resolve(new Response('ok', { status }))) as unknown as typeof fetch;

  beforeEach(() => {
    resetProbeCache();
  });

  it('uses mode `cors`, never `no-cors`, and presents the app origin', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([String(input), init]);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await probeSimOrigin('https://sims.example', 'https://app.example', spy);
    expect(result.outcome).toBe('OK');
    const [url, init] = seen[0] ?? [];
    expect(url).toBe(`https://sims.example${SIM_ORIGIN_PROBE_PATH}`);
    // An opaque response cannot be told apart from a blocked one, which is the entire question.
    expect(init?.mode).toBe('cors');
    expect(init?.credentials).toBe('omit');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Orrery-App-Origin']).toBe('https://app.example');
  });

  it('treats a 5xx as DNS and a 4xx as FIREWALL, because the advice differs', async () => {
    // A 4xx means the origin was REACHED and chose not to answer, which is a deployment fault; a 5xx
    // means the origin exists and is unwell. Neither is the student's network.
    expect(
      (await probeSimOrigin('https://a.example', 'https://app.example', respond(502))).outcome,
    ).toBe('DNS');
    expect(
      (await probeSimOrigin('https://b.example', 'https://app.example', respond(404))).outcome,
    ).toBe('FIREWALL');
  });

  it('caches a SUCCESS, so a lesson with twelve sims does not fire twelve probes', async () => {
    let calls = 0;
    const counting = (() => {
      calls += 1;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    await probeSimOrigin('https://cached.example', 'https://app.example', counting);
    await probeSimOrigin('https://cached.example', 'https://app.example', counting);
    expect(calls).toBe(1);
  });

  it('EXPIRES a cached success, so a network that changes is re-asked rather than remembered', async () => {
    let calls = 0;
    let clock = 0;
    const counting = (() => {
      calls += 1;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    const now = (): number => clock;
    await probeSimOrigin('https://ttl.example', 'https://app.example', counting, now);
    clock = PROBE_CACHE_TTL_MS - 1;
    await probeSimOrigin('https://ttl.example', 'https://app.example', counting, now);
    expect(calls).toBe(1);
    // A tab left open across a lesson period must re-ask: a cache nobody can clear will still be
    // declaring a fixed network broken hours later.
    clock = PROBE_CACHE_TTL_MS + 1;
    await probeSimOrigin('https://ttl.example', 'https://app.example', counting, now);
    expect(calls).toBe(2);
  });

  it('does NOT cache a failure, so a student who fixes their network is not left with stale advice', async () => {
    // The moment a student is least able to interpret a cached failure is immediately after they fix the
    // thing that caused it.
    let calls = 0;
    const flaky = (() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    expect(
      (await probeSimOrigin('https://flaky.example', 'https://app.example', flaky)).outcome,
    ).toBe('FIREWALL');
    expect(
      (await probeSimOrigin('https://flaky.example', 'https://app.example', flaky)).outcome,
    ).toBe('OK');
    expect(calls).toBe(2);
  });
});
