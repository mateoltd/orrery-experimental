import { describe, expect, it } from 'vitest';
import { type BridgeHandlers, connectSim, type SimCapabilities } from './bridge.js';
import { defineSim } from './define.js';
import { checksumState } from './state.js';

const CAPABILITIES: SimCapabilities = { grading: true, stepper: true, scenarios: [] };

/**
 * `connectSim`: waiting for the handshake, since `createHostBridge` needs a nonce it does not have yet.
 *
 * ## WHY THIS TEST EXISTS
 *
 * `createHostBridge` had ZERO callers in the repository. Every simulation imported the SDK, rendered a
 * canvas, and completed no handshake — so a "simulation" was a picture of one, and nothing could be
 * graded server-side from stored state. The bridge was correct and unreachable, which is the failure
 * mode a passing unit suite is worst at finding.
 */
describe('connectSim', () => {
  const handlers = (over: Partial<BridgeHandlers> = {}): BridgeHandlers => ({
    getState: () => ({ t: 1 }),
    ...over,
  });
  const posted: unknown[] = [];
  const transport = () => {
    posted.length = 0;
    let handler: (frame: unknown, source: unknown) => void = () => {};
    return {
      post: (frame: unknown): void => {
        posted.push(frame);
      },
      subscribe: (h: (frame: unknown, source: unknown) => void): (() => void) => {
        handler = h;
        return () => {
          handler = () => {};
        };
      },
      deliver: (frame: unknown): void => {
        handler(frame, { name: 'host' });
      },
    };
  };

  const initFrame = (over: Record<string, unknown> = {}): unknown => ({
    type: 'sim:init',
    protocol: 1,
    nonce: 'nonce-1',
    simId: 'maths.projectile-motion',
    simVersion: '1.0.0',
    params: {},
    seed: 'seed-1',
    mode: 'lesson',
    ...over,
  });

  // THE PARAMS IN `sim:init` ARE THE LESSON'S, AND THEY WERE BEING DROPPED.
  //
  // The handler marked the simulation started and returned, so a host could carry a teacher's parameter
  // values, stamp them on `sim:init`, and the simulation would begin on whatever defaults its own source
  // file hardcoded. Nothing reported the difference. This took a browser probe to notice, because no test
  // asserted the values arrived and every conformance script set its parameters to their defaults.
  it('APPLIES the params carried by `sim:init`', () => {
    const t = transport();
    const seen: unknown[] = [];
    const connection = connectSim({
      transport: t,
      handlers: handlers({ onSetParams: (params) => seen.push(params) }),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    t.deliver(initFrame({ params: { speed: 25, angle: 45 } }));
    expect(connection.started).toBe(true);
    expect(seen).toEqual([{ speed: 25, angle: 45 }]);
  });

  it('applies `sim:init` params even when they are empty, so a lesson CAN clear them', () => {
    const t = transport();
    const seen: unknown[] = [];
    connectSim({
      transport: t,
      handlers: handlers({ onSetParams: (params) => seen.push(params) }),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    t.deliver(initFrame({ params: {} }));
    expect(seen).toEqual([{}]);
  });

  it('tolerates a `sim:init` with NO params at all, rather than calling the handler with undefined', () => {
    const t = transport();
    let calls = 0;
    connectSim({
      transport: t,
      handlers: handlers({
        onSetParams: () => {
          calls += 1;
        },
      }),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    const frame = initFrame() as Record<string, unknown>;
    delete frame.params;
    t.deliver(frame);
    expect(calls).toBe(0);
  });

  it('has NO bridge before `sim:init`, because there is no nonce to echo yet', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    expect(connection.started).toBe(false);
    expect(connection.bridge).toBeNull();
    expect(posted).toEqual([]);
  });

  it('ignores a frame that arrives before the init, rather than reporting it as an error', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    // A frame can legitimately arrive before the init that authorises it. Reporting every one buries
    // the real cause in noise.
    t.deliver({ type: 'sim:command', name: 'play' });
    t.deliver({ type: 'sim:teardown' });
    expect(connection.started).toBe(false);
    expect(posted).toEqual([]);
  });

  it('sends `sim:ready` on init, echoing the nonce', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
      exports: ['range'],
    });
    t.deliver(initFrame());
    expect(connection.started).toBe(true);
    expect(posted[0]).toMatchObject({
      type: 'sim:ready',
      nonce: 'nonce-1',
      simId: 'maths.projectile-motion',
      simVersion: '1.0.0',
      exports: ['range'],
    });
  });

  it('REFUSES a version the host did not ask for, and says which bundle answered', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    // The host's entire reason for pinning is to render the version the student's results were
    // computed against. A handshake that succeeds against the wrong physics is worse than a failure.
    t.deliver(initFrame({ simVersion: '2.0.0' }));
    expect(connection.started).toBe(false);
    expect(connection.failure).toContain('1.0.0');
    expect(connection.failure).toContain('2.0.0');
    expect(posted).toEqual([]);
  });

  it('REFUSES an init with no nonce, because no outbound frame could be authenticated', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    t.deliver(initFrame({ nonce: '' }));
    expect(connection.started).toBe(false);
    expect(connection.failure).toContain('nonce');
  });

  it('resolves `whenStarted` with the bridge, so a caller can await the handshake', async () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    const started = connection.whenStarted();
    t.deliver(initFrame());
    await expect(started).resolves.toBe(connection.bridge);
  });

  it('answers a state request with a REAL checksum, not an empty string', () => {
    const t = transport();
    connectSim({
      transport: t,
      handlers: { getState: () => ({ t: 1, speed: 25 }) },
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    t.deliver(initFrame());
    posted.length = 0;
    t.deliver({ type: 'sim:requestState', nonce: 'nonce-1', reason: 'save' });
    const frame = posted.find((f) => (f as { type: string }).type === 'sim:state') as {
      checksum: string;
      state: unknown;
    };
    // `''` makes the field decorative: the host would validate every state, including a corrupted one.
    expect(frame.checksum).not.toBe('');
    expect(frame.checksum).toBe(checksumState(frame.state));
  });

  it('releases the subscription on dispose, so a torn-down sim is not still listening', () => {
    const t = transport();
    const connection = connectSim({
      transport: t,
      handlers: handlers(),
      expectedSimId: 'maths.projectile-motion',
      expectedVersion: '1.0.0',
      capabilities: CAPABILITIES,
    });
    connection.dispose();
    t.deliver(initFrame());
    expect(connection.started).toBe(false);
  });
});

/**
 * The grader's arity is checked AT DEFINITION.  (P6-T11)
 *
 * Three gold simulations were written `grade(answer, context)` where the contract is
 * `grade(state, params, answer)`. A two-argument function is not a runtime type error, so the SDK handed
 * them the parameters as the answer, `parseAnswer` failed, and **every answer scored 0** with nothing
 * reporting an error anywhere. It is now a load-time failure naming the simulation.
 */
describe('defineSim checks the grader signature', () => {
  const definition = () =>
    ({
      meta: {
        id: 'maths.arity',
        title: 'Arity',
        version: '1.0.0',
        subjects: ['maths'],
        license: 'CC-BY-4.0',
        provenance: 'ORIGINAL',
        protocol: 1,
      },
      params: {},
      controls: { params: false, state: false, scenarios: [] },
      accessibility: {
        keyboard: true,
        screenReaderSummary: 'A screen reader summary long enough to pass the declaration check.',
        reducedMotion: true,
        textAlternative: 'A text alternative long enough to pass the declaration check here.',
        summary: 'A summary long enough to pass the declaration check that defineSim performs.',
      },
      grade: () => ({ points: 0, maxPoints: 4 }),
    }) as never;

  it('REFUSES a grader that takes the wrong number of arguments', () => {
    expect(() => defineSim(definition())).toThrow(/GRADER_ARITY/u);
    // The message has to SAY what to do, because the arity is not obvious from a stack trace.
    expect(() => defineSim(definition())).toThrow(/grade takes \(state, params, answer\)/u);
  });

  it('accepts a grader that takes all three', () => {
    const module = defineSim({
      ...(definition() as unknown as Record<string, unknown>),
      grade: (_state: unknown, _params: unknown, _answer: unknown) => ({ points: 0, maxPoints: 4 }),
    } as never);
    expect(module.grader.grade).toBeTypeOf('function');
  });
});
