// @vitest-environment jsdom

/**
 * `pointerLockGuard`.  (P8-T5)
 *
 * The whole task is one honesty constraint. `Escape` releases pointer lock, browsers deliberately prevent
 * intercepting it, and `plans/09` §6.1 says any product claiming otherwise is lying. So the guard must not count an
 * `Escape` release, must not block the key, and must say in its copy that pointer lock is a deterrent rather than a
 * lock. Every test here is one of those three.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it } from 'vitest';

import { isPointerLockEvidence, POINTER_LOCK_GRACE_MS, PointerLockGuard } from './pointerLockGuard';
import type { Evidence } from './watchdog';

const T0 = 1_800_000_000_000;

class FakeHost {
  readonly listeners = new Map<string, (() => void)[]>();
  pointerLockElement: Element | null = {} as Element;

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  get count(): number {
    return (this.listeners.get('pointerlockchange') ?? []).length;
  }
}

const harness = (graceMs = POINTER_LOCK_GRACE_MS) => {
  const clock = new FrozenClock(T0);
  const host = new FakeHost();
  const seen: Evidence[] = [];
  const guard = new PointerLockGuard(
    clock,
    (evidence) => {
      seen.push(evidence);
    },
    host,
    graceMs,
  );
  guard.attach();
  return { clock, host, seen, guard };
};

describe('the grace period', () => {
  it('emits NOTHING the instant the pointer is lost', () => {
    // The guard cannot tell an `Escape` release from any other, so it must wait rather than accuse.
    const { host, seen, guard } = harness();
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    expect(seen).toEqual([]);
    expect(guard.isInGrace).toBe(true);
  });

  it('counts the loss only once the grace has expired', () => {
    const { clock, host, seen, guard } = harness(3_000);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(2_999);
    expect(guard.tick()).toBe(false);
    expect(seen).toEqual([]);
    clock.advance(1);
    expect(guard.tick()).toBe(true);
    expect(seen.map((e) => e.kind)).toEqual(['POINTERLOCK_LOST']);
  });

  it('counts ONE loss however many times it is checked', () => {
    // A timer that fires every 100 ms against an already-counted loss would emit hundreds of events.
    const { clock, host, seen, guard } = harness(1_000);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(5_000);
    let emitted = 0;
    for (let i = 0; i < 50; i += 1) emitted += guard.tick() ? 1 : 0;
    expect(emitted).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('FORGIVES a loss when the pointer comes back inside the grace', () => {
    // This is the `Escape` case in practice: the student wanted their cursor back, and they got it.
    const { clock, host, seen, guard } = harness(3_000);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(500);
    host.pointerLockElement = {} as Element;
    host.fire('pointerlockchange');
    clock.advance(10_000);
    expect(guard.tick()).toBe(false);
    expect(seen).toEqual([]);
    expect(guard.hasCountedLoss).toBe(false);
  });

  it('starts a NEW grace after a forgiven loss, rather than inheriting the old one', () => {
    const { clock, host, seen, guard } = harness(1_000);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(500);
    host.pointerLockElement = {} as Element;
    host.fire('pointerlockchange');
    // Second loss, well after the first grace would have ended.
    clock.advance(5_000);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    expect(guard.tick()).toBe(false);
    clock.advance(1_000);
    expect(guard.tick()).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe('honesty about Escape', () => {
  it('does not block `Escape`, because the browser will not let it and claiming otherwise is a lie', () => {
    const { host, guard } = harness();
    // The guard subscribes to `pointerlockchange` and `pointerlockerror` only. A `keydown` listener here would be
    // either ineffective (the browser releases first) or a lie in the source.
    expect([...host.listeners.keys()].sort()).toEqual(['pointerlockchange', 'pointerlockerror']);
    expect(guard.escapeIsSimulationKey).toBe(false);
  });

  it('records `Escape` involvement as UNKNOWN rather than guessing', () => {
    const { clock, host, seen, guard } = harness(100);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(100);
    guard.tick();
    // A guess here puts a fabricated fact in a teacher's timeline. `null` is the honest reading of an unobservable.
    expect(seen[0]?.detail?.escapePossiblyInvolved).toBeNull();
  });

  it('records whether `Escape` belongs to the embedded simulation, which it usually does', () => {
    const { clock, host, seen, guard } = harness(100);
    guard.setEscapeConsumedBySimulation(true);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(100);
    guard.tick();
    expect(guard.escapeIsSimulationKey).toBe(true);
    expect(seen[0]?.detail?.escapeBelongsToSimulation).toBe(true);
  });

  it('says DETERRENT, not lock, in the disclosure', () => {
    expect(PointerLockGuard.DISCLOSURE).toContain('discourages');
    expect(PointerLockGuard.DISCLOSURE).toContain('always leave it');
    expect(PointerLockGuard.DISCLOSURE).toContain('Escape');
    // The word "lock" as a claim of enforcement is exactly the lie §6.1 forbids.
    expect(PointerLockGuard.DISCLOSURE).not.toMatch(/cannot (be )?(leave|exit)|prevents? leaving/);
  });
});

describe('plumbing', () => {
  it('subscribes once and unsubscribes once', () => {
    const { host, guard } = harness();
    guard.attach();
    expect(host.count).toBe(1);
    guard.detach();
    expect(host.count).toBe(0);
  });

  it('emits NOTHING while detached', () => {
    const { clock, host, seen, guard } = harness(100);
    guard.detach();
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(1_000);
    expect(guard.tick()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('reports a REFUSED request as a refusal rather than a loss', () => {
    const { host, seen } = harness();
    host.fire('pointerlockerror');
    // Nothing was lost, so `plans/09` §6's table has no event for it. Reported so the overlay can explain a cursor
    // that never vanished, and explicitly not as `POINTERLOCK_LOST`.
    expect(seen.map((e) => e.kind)).toEqual(['POINTERLOCK_ENTERED']);
    expect(isPointerLockEvidence(seen[0] as Evidence)).toBe(true);
  });

  it('stamps evidence from the injected clock, never the host clock', () => {
    const { clock, host, seen, guard } = harness(100);
    clock.advance(7_777);
    host.pointerLockElement = null;
    host.fire('pointerlockchange');
    clock.advance(100);
    guard.tick();
    expect(seen[0]?.at).toBe(T0 + 7_877);
  });
});
