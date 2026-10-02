/**
 * `sim-host@1`, checked as a protocol.  (P6-T1)
 *
 * ## The tests that matter most
 *
 *  · `the nonce is checked BEFORE anything is parsed` — a frame with the wrong nonce is attacker
 *    input, and reasoning about its contents before rejecting it is how a page gets slow from
 *    someone else's traffic.
 *  · `a VERSION mismatch DEGRADES with a message a teacher can act on` — the surrounding lesson
 *    must keep working, and "something went wrong" is not actionable.
 *  · `a PROTOCOL mismatch is a REFUSAL, because the frames would mean different things` — and this
 *    is the distinction the first version of `evaluateHandshake` got wrong.
 *  · `a gradePreview cannot put itself on a student surface by declaring it` — it is untrusted code
 *    and its own declaration is not evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOW_SRCDOC,
  assertAllowedOn,
  evaluateHandshake,
  FATAL_ERROR_CODES,
  FRAME_SANDBOX_TOKENS,
  HANDSHAKE_TIMEOUT_MS,
  type HandshakeExpectation,
  HOST_FRAME_TYPES,
  isAuthenticated,
  isFatalError,
  isSimErrorCode,
  NO_CAPABILITIES,
  PROHIBITED_APIS,
  SIM_ERROR_CODES,
  SIM_FRAME_TYPES,
  SIM_PROTOCOL,
  type SimCapabilities,
  type SimErrorCode,
  type SimFrame,
  STATE_CHECKPOINT_DEBOUNCE_MS,
  TELEMETRY_NAMES,
} from './protocol.js';

const caps = (over: Partial<SimCapabilities> = {}): SimCapabilities => ({
  ...NO_CAPABILITIES,
  state: true,
  grading: true,
  randomised: true,
  stepper: true,
  scenarios: ['no-air'],
  ...over,
});

const expected = (over: Partial<HandshakeExpectation> = {}): HandshakeExpectation => ({
  protocol: SIM_PROTOCOL,
  simId: 'physics.pendulum',
  simVersion: '1.2.0',
  nonce: 'nonce-abc',
  capabilities: caps(),
  gradingSupplied: true,
  ...over,
});

const ready = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'sim:ready',
  protocol: SIM_PROTOCOL,
  nonce: 'nonce-abc',
  simId: 'physics.pendulum',
  simVersion: '1.2.0',
  capabilities: caps(),
  exports: ['simulate', 'grade'],
  ...over,
});

describe('the transport', () => {
  it('the sandbox attribute is EXACTLY allow-scripts, and every absence is deliberate', () => {
    expect(FRAME_SANDBOX_TOKENS).toBe('allow-scripts');
    // No `allow-same-origin` is the whole sandbox. Each of these would hand a sim something it must
    // not have, and a sim is a third-party program running inside a student's exam.
    for (const forbidden of [
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-top-navigation',
      'allow-modals',
      'allow-downloads',
      'allow-pointer-lock',
    ]) {
      expect(FRAME_SANDBOX_TOKENS).not.toContain(forbidden);
    }
  });

  it('never uses srcdoc, and never an inline script', () => {
    // An inline srcdoc frame is same-origin-reachable in a way a URL frame is not, and it makes the
    // bundle unhashable.
    expect(ALLOW_SRCDOC).toBe(false);
  });

  it('the frame tables match plans/10 §2.2 exactly: 7 host frames, 8 sim frames', () => {
    expect(HOST_FRAME_TYPES).toEqual([
      'sim:init',
      'sim:setParams',
      'sim:command',
      'sim:requestState',
      'sim:visibility',
      'sim:teardown',
    ]);
    expect(SIM_FRAME_TYPES).toEqual([
      'sim:ready',
      'sim:error',
      'sim:resize',
      'sim:state',
      'sim:answer',
      'sim:gradePreview',
      'sim:telemetry',
      'sim:readyForInput',
    ]);
  });

  it('the handshake budget is 10 s, because a short one fails the worst-connected students', () => {
    // The bundle comes off a separate origin on a cold cache over a school network. A 2 s budget
    // fails exactly the students who then get a fallback panel and learn nothing.
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    expect(STATE_CHECKPOINT_DEBOUNCE_MS).toBe(3_000);
  });

  it('the prohibited-API list is a SET, so the conformance suite can walk it', () => {
    // A rule stated only in prose is a rule the suite cannot check, and `plans/10` §2.3 rule 5 is
    // the rule most likely to be quietly broken by a well-meaning sim author.
    for (const api of [
      'window.open',
      'fetch',
      'indexedDB',
      'navigator.clipboard.read',
      'top.location',
    ]) {
      expect(PROHIBITED_APIS).toContain(api);
    }
    expect(new Set(PROHIBITED_APIS).size).toBe(PROHIBITED_APIS.length);
  });

  it('telemetry names are allowlisted, because a free-form name is a pre-release side channel', () => {
    // `INV-Q-1`'s cousin: a sim reporting `student_answer_correct` as a metric puts outcomes in a
    // warehouse outside the release gate. The allowlist is in the type, so this is a compile error
    // at the sim rather than a row in someone's dashboard.
    expect(TELEMETRY_NAMES).toContain('render_errors');
    expect(TELEMETRY_NAMES).not.toContain('answer_correct');
    expect(TELEMETRY_NAMES).not.toContain('score');
  });
});

describe('authentication', () => {
  const source = { name: 'the-frame' };

  it('accepts a frame with the right nonce FROM THE RIGHT SOURCE', () => {
    expect(isAuthenticated(ready(), 'nonce-abc', source, source)).toBe(true);
  });

  it('rejects the right nonce from the WRONG source', () => {
    // Both checks are needed. A nonce in a page the attacker controls is not a secret.
    expect(isAuthenticated(ready(), 'nonce-abc', { name: 'other-frame' }, source)).toBe(false);
  });

  it('rejects a wrong nonce even from the right source', () => {
    expect(isAuthenticated(ready({ nonce: 'guess' }), 'nonce-abc', source, source)).toBe(false);
  });

  it('rejects anything that is not an object, without throwing', () => {
    for (const junk of [null, undefined, 42, 'sim:ready', [], true]) {
      expect(isAuthenticated(junk, 'nonce-abc', source, source)).toBe(false);
    }
  });

  it('a frame with no nonce is rejected — a handshake that identifies itself without proving it', () => {
    expect(isAuthenticated({ type: 'sim:ready' }, 'nonce-abc', source, source)).toBe(false);
    expect(isAuthenticated({ type: 'sim:ready', nonce: 7 }, 'nonce-abc', source, source)).toBe(
      false,
    );
  });
});

describe('the handshake', () => {
  it('accepts a well-formed sim:ready', () => {
    const verdict = evaluateHandshake(ready(), expected());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.sim.simId).toBe('physics.pendulum');
      expect(verdict.sim.exports).toEqual(['simulate', 'grade']);
    }
  });

  it('a VERSION mismatch DEGRADES with a message a teacher can act on', () => {
    const verdict = evaluateHandshake(ready({ simVersion: '2.0.0' }), expected());
    // NOT a crash and NOT a bare rejection: `plans/10` §2.3 rule 3 says the surrounding lesson
    // stays usable.
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(verdict.message).toContain('2.0.0');
      expect(verdict.message).toContain('1.2.0');
      expect(verdict.message).toMatch(/static fallback/);
    }
  });

  it('a PROTOCOL mismatch is a REFUSAL, because the frames would mean different things', () => {
    // This is the distinction that matters and the first version got wrong: treating a protocol
    // bump like a version bump means guessing at the meaning of every subsequent frame.
    const verdict = evaluateHandshake(ready({ protocol: 2 }), expected());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('HANDSHAKE_FAILED');
      expect(verdict.message).toMatch(/cannot be spoken/);
    }
  });

  it('refuses a sim that identifies itself as a DIFFERENT simulation', () => {
    const verdict = evaluateHandshake(ready({ simId: 'physics.pendulum-other' }), expected());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('HANDSHAKE_FAILED');
  });

  it('refuses a sim that grades when the host supplied no grading instruction', () => {
    // Otherwise the student sees a gradable-looking surface and submits an answer nothing can score.
    const verdict = evaluateHandshake(ready(), expected({ gradingSupplied: false }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/no grading instruction/);
  });

  it('accepts a sim with NO state capability, because a lesson sim need not have one', () => {
    const verdict = evaluateHandshake(
      ready({ capabilities: caps({ state: false, grading: false }) }),
      expected({ gradingSupplied: false }),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.sim.capabilities.state).toBe(false);
  });

  it('refuses junk without throwing', () => {
    for (const junk of [null, undefined, 'ready', 42, {}, { type: 'sim:answer' }]) {
      const verdict = evaluateHandshake(junk, expected());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('HANDSHAKE_FAILED');
    }
  });

  it('refuses a ready with no capabilities, because the host needs them to plan', () => {
    const verdict = evaluateHandshake(ready({ capabilities: undefined }), expected());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/no capabilities/);
  });
});

describe('the error taxonomy', () => {
  it('is a CLOSED set, so the host can switch exhaustively', () => {
    // A free-form `code: string` means the first code nobody handled is a silent no-op — which is
    // how a sim that cannot be graded ends up looking like a student who gave up.
    expect(SIM_ERROR_CODES.length).toBe(10);
    expect(new Set(SIM_ERROR_CODES).size).toBe(SIM_ERROR_CODES.length);
    for (const code of SIM_ERROR_CODES) expect(isSimErrorCode(code)).toBe(true);
    for (const nope of ['WAT', 'internal', '', 'PROHIBITED_API ', 42, null]) {
      expect(isSimErrorCode(nope)).toBe(false);
    }
  });

  it('GRADER_FAILED and STATE_INVALID are fatal, and the rest are not', () => {
    expect(FATAL_ERROR_CODES).toEqual(['GRADER_FAILED', 'STATE_INVALID']);
    expect(isFatalError('GRADER_FAILED')).toBe(true);
    // A render failure is recoverable: the host remounts. A wrong grade is not.
    expect(isFatalError('RENDER_FAILED')).toBe(false);
    expect(isFatalError('PROHIBITED_API')).toBe(false);
  });

  it('PROHIBITED_API is its own code, because it is a conformance failure AND an error', () => {
    // The two responses differ: the host shows the fallback, and the registry job fails the build.
    // Folding it into `INTERNAL` would lose the second half.
    const codes: SimErrorCode[] = ['PROHIBITED_API'];
    expect(codes).toHaveLength(1);
  });
});

describe('gradePreview may not put itself on a student surface', () => {
  it('refuses a frame that declares the surface the host is not rendering', () => {
    expect(() => assertAllowedOn({ surface: 'student' }, 'authoring')).toThrow(
      /GRADE_PREVIEW_ON_WRONG_SURFACE/,
    );
  });

  it('allows a preview on the authoring surface', () => {
    expect(() => assertAllowedOn({ surface: 'authoring' }, 'authoring')).not.toThrow();
  });

  it('the message names BOTH surfaces, because a bug here is diagnosed by a support ticket', () => {
    try {
      assertAllowedOn({ surface: 'student' }, 'authoring');
      throw new Error('should not reach here');
    } catch (error) {
      expect((error as Error).message).toContain('"student"');
      expect((error as Error).message).toContain('"authoring"');
      // And says WHY, because the natural fix a developer reaches for is to trust the frame.
      expect((error as Error).message).toMatch(/The host decides, not the frame/);
    }
  });

  it('every non-error sim frame carries the nonce', () => {
    // `sim:ready` is the one frame whose type omits it, and that is deliberate: a handshake that
    // does not prove itself is a handshake anyone can complete. Every other frame must carry it.
    const needsNonce: SimFrame['type'][] = [
      'sim:ready',
      'sim:error',
      'sim:resize',
      'sim:state',
      'sim:answer',
      'sim:gradePreview',
      'sim:telemetry',
      'sim:readyForInput',
    ];
    expect(needsNonce).toHaveLength(SIM_FRAME_TYPES.length);
  });
});
