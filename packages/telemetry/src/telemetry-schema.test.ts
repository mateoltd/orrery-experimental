/**
 * The closed `detail` schema as it arrives.  (P14-T14, TM-20, `INV-TELEMETRY-2`)
 *
 * ## WHY THE FIRST TEST IS AN IDENTITY CHECK AND NOT A COMPARISON
 *
 * `TELEMETRY_DETAIL_KEYS` is asserted to BE `EVIDENCE_DETAIL_KEYS` — `toBe`, not `toEqual`. A copy would satisfy every
 * other assertion in this file and every assertion in `scripts/audit-payloads.mjs` right up until the day somebody added a
 * key to one of them, and then the gate would be auditing a vocabulary the writer does not use. **Reference identity is
 * the only assertion that fails the day a second list appears**, which is the failure this file exists to prevent.
 */

import { EVIDENCE_DETAIL_KEYS, PII_OR_CONTENT_KEYS } from '@orrery/exam-engine/evidence';
import { describe, expect, it } from 'vitest';
import {
  isMachineWord,
  MACHINE_WORD_DETAIL_KEYS,
  MAX_TELEMETRY_DETAIL_VALUE_CHARS,
  narrowTelemetryDetail,
  TELEMETRY_DETAIL_KEYS,
  TELEMETRY_SCHEMA,
} from './schema.js';

describe('THERE IS ONE DETAIL VOCABULARY, AND IT IS THE EVIDENCE ONE', () => {
  it('the exported tuple IS the evidence tuple, not a copy of it', () => {
    expect(TELEMETRY_DETAIL_KEYS).toBe(EVIDENCE_DETAIL_KEYS);
  });

  it('and it is the twenty-two names `audit:payloads` allows', () => {
    // The count is the assertion a reader can check against the gate's own output line
    // (`telemetry detail keys allowed: 22`), so a widening is visible without reading either source.
    expect(TELEMETRY_DETAIL_KEYS).toHaveLength(22);
  });

  it('THE PROPERTY: none of them names content or a person', () => {
    // `audit-payloads.mjs` keeps an INDEPENDENT copy of this list on purpose, so this is a second opinion rather than
    // the control. It is here because `scripts/audit-telemetry-leak.mjs` cannot see a key list — a vocabulary leak is
    // not a projection leak — and a test that could catch it should exist even if the gate cannot.
    const forbidden = new Set<string>(PII_OR_CONTENT_KEYS);
    for (const key of TELEMETRY_DETAIL_KEYS) expect(forbidden.has(key), key).toBe(false);
  });

  it('`scripts/audit-telemetry-leak.mjs` and this file check different things, and neither checks the other', () => {
    expect(Object.keys(TELEMETRY_SCHEMA).sort()).toEqual([
      'detailKeys',
      'isDetailKey',
      'isDetailValue',
      'machineWordKeys',
      'maxValueChars',
      'narrow',
    ]);
  });
});

describe('EVERY ALLOWLISTED KEY IS ACCEPTED, because a closed set that refuses everything is noticed in production', () => {
  // One plausible value per key, chosen as the shape `evidence.ts` documents for it. A key that cannot hold its own
  // documented value is a key in the tuple that no writer can use, which is the failure mode of a list nobody exercises.
  const SAMPLES: Record<string, string | number | boolean | null> = {
    advisory: true,
    awayForMs: 12_000,
    countsAgainstTabHides: true,
    droppedEventCount: 3,
    enforcedByServer: true,
    escapeBelongsToSimulation: true,
    escapePossiblyInvolved: null,
    graceMs: 900,
    lostAt: 1_700_000_000_000,
    offsetMs: -250,
    outcome: 'STOP',
    peerTabId: 'tab-2',
    phase: 'LOADING',
    reason: 'AbortError',
    requested: true,
    status: 'WARN',
    studentWarned: false,
    tabWasHidden: true,
    threshold: 3,
    wasRequested: true,
    simId: 'mechanics.newtons-cradle',
    code: 'LOAD_TIMEOUT',
  };

  it('each of the twenty-two passes with its documented value', () => {
    for (const key of TELEMETRY_DETAIL_KEYS) {
      const verdict = narrowTelemetryDetail({ [key]: SAMPLES[key] });
      expect(verdict.ok, `${key}: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it('and every one of the twenty-two is exercised by the sample table, so a new key cannot slip in unexercised', () => {
    // The same discipline as `audit-payloads.mjs`'s floor: adding a key is a VISIBLE event, not a silent widening.
    expect(Object.keys(SAMPLES).sort()).toEqual([...TELEMETRY_DETAIL_KEYS].sort());
  });
});

describe('AN ILLEGAL KEY IS REFUSED, AND THE REFUSAL NAMES THE KEY', () => {
  // The `TM-20` leak, arriving over the wire. `{ detail: { studentEmail } }` is what a spread of a wider object produces.
  const CASES: readonly { readonly detail: unknown; readonly reason: string }[] = [
    { detail: { studentEmail: 'a@b.c' }, reason: 'DETAIL_KEY_NOT_ALLOWED' },
    { detail: { answer: 'purple' }, reason: 'DETAIL_KEY_NOT_ALLOWED' },
    { detail: { note: 'x' }, reason: 'DETAIL_KEY_NOT_ALLOWED' },
    { detail: { awayForMs: 12, studentName: 'Alex' }, reason: 'DETAIL_KEY_NOT_ALLOWED' },
    // A legal key alongside the illegal one does not buy the detail a pass: the whole thing is refused.
    { detail: { threshold: 1, pupilEmail: 'b@c.d' }, reason: 'DETAIL_KEY_NOT_ALLOWED' },
  ];

  for (const testCase of CASES) {
    it(`refuses ${JSON.stringify(testCase.detail)}`, () => {
      const verdict = narrowTelemetryDetail(testCase.detail);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('expected a refusal');
      expect(verdict.reason).toBe(testCase.reason);
      // The KEY is returned and the VALUE is not, so a refusal can be logged without becoming the leak.
      expect(typeof verdict.key).toBe('string');
      expect(JSON.stringify(verdict)).not.toContain('purple');
      expect(JSON.stringify(verdict)).not.toContain('@');
    });
  }

  it('THE KEY ORDER DOES NOT DECIDE THE REASON, so a counter means something', () => {
    // `Object.entries` iterates in insertion order, which is why the keys are checked in their own pass. A single pass
    // would report a bad VALUE beside a PII key as the value problem, and the two want different responses from the
    // ingestion layer.
    const valueFirst = narrowTelemetryDetail({
      awayForMs: { nested: true },
      studentEmail: 'a@b.c',
    });
    expect(valueFirst.ok).toBe(false);
    if (valueFirst.ok) throw new Error('expected a refusal');
    expect(valueFirst.reason).toBe('DETAIL_KEY_NOT_ALLOWED');
  });
});

describe('A `detail` THAT IS NOT A PLAIN OBJECT IS REFUSED', () => {
  for (const shape of [[], 'awayForMs', 12, true, null]) {
    it(`refuses ${JSON.stringify(shape)}`, () => {
      const verdict = narrowTelemetryDetail(shape);
      expect(verdict).toEqual({ ok: false, reason: 'DETAIL_NOT_AN_OBJECT', key: null });
    });
  }
});

describe('A VALUE THAT IS NOT A PRIMITIVE IS REFUSED, because a key allowlist does not stop a payload', () => {
  it('refuses a nested object under a legal key', () => {
    const verdict = narrowTelemetryDetail({ reason: { answer: 'purple' } });
    expect(verdict).toEqual({ ok: false, reason: 'DETAIL_VALUE_NOT_PRIMITIVE', key: 'reason' });
  });

  it('refuses an array, and `undefined`, which `isEvidenceDetailValue` refuses deliberately', () => {
    // `undefined` is refused rather than dropped so that one event has one stored spelling.
    expect(narrowTelemetryDetail({ threshold: undefined })).toEqual({
      ok: false,
      reason: 'DETAIL_VALUE_NOT_PRIMITIVE',
      key: 'threshold',
    });
    expect(narrowTelemetryDetail({ threshold: [1, 2] })).toEqual({
      ok: false,
      reason: 'DETAIL_VALUE_NOT_PRIMITIVE',
      key: 'threshold',
    });
  });
});

describe('A STRING VALUE IS SHAPED, AND THE SHAPES ARE THE ONES `@orrery/config` ALREADY BELIEVES IN', () => {
  it('refuses over the ceiling rather than truncating half a value into a field that says "duration"', () => {
    const verdict = narrowTelemetryDetail({
      peerTabId: 't'.repeat(MAX_TELEMETRY_DETAIL_VALUE_CHARS + 1),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.reason).toBe('DETAIL_VALUE_TOO_LONG');
  });

  it('and accepts one exactly at it', () => {
    // The value is SPACED on purpose. An unbroken 128-character run is refused — and refused for a *different* reason,
    // which is its own test below. Two ceilings that overlap are not a bug, but the interaction is worth not being
    // surprised by, so the boundary case here is one the high-entropy rule leaves alone.
    const at = 'ab '.repeat(43).slice(0, MAX_TELEMETRY_DETAIL_VALUE_CHARS);
    expect(at).toHaveLength(MAX_TELEMETRY_DETAIL_VALUE_CHARS);
    expect(narrowTelemetryDetail({ peerTabId: at }).ok).toBe(true);
  });

  it('AN UNBROKEN RUN AT THE CEILING IS REFUSED AS A CREDENTIAL, not as too long, and the reason is the honest one', () => {
    // `scrubMessage`'s HIGH_ENTROPY class is "32+ unbroken alphanumerics", so 128 letters is a session id, a key or a
    // digest. The value-shape rule sees it first and says so; the ceiling is not the thing that caught it, and a log
    // line that said "too long" would send somebody looking for a client that sent a big string.
    const verdict = narrowTelemetryDetail({
      peerTabId: 't'.repeat(MAX_TELEMETRY_DETAIL_VALUE_CHARS),
    });
    expect(verdict).toEqual({
      ok: false,
      reason: 'DETAIL_VALUE_LOOKS_LIKE_A_CREDENTIAL',
      key: 'peerTabId',
    });
  });

  it('THE PROPERTY: a credential shape is refused under a legal key', () => {
    // `scrubMessage`'s whole subject: an address, a bearer credential, a JWT and a high-entropy run are recognisable by
    // SHAPE. Reused rather than re-listed, because a second value-shape list is a list that disagrees with the first.
    for (const value of [
      'student@school.invalid',
      'Bearer abc.def-ghi_jkl',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'A'.repeat(40),
    ]) {
      const verdict = narrowTelemetryDetail({ peerTabId: value });
      expect(verdict.ok, value).toBe(false);
      if (verdict.ok) throw new Error('expected a refusal');
      expect(verdict.reason, value).toBe('DETAIL_VALUE_LOOKS_LIKE_A_CREDENTIAL');
    }
  });
});

describe('A KEY DOCUMENTED AS A MACHINE WORD MUST HOLD ONE — WHICH IS THE `14` §7.5 ANSWER', () => {
  it('THE PROPERTY: a sentence in `reason` is refused, so a free-text answer cannot be retained as evidence', () => {
    // `14` §7.5: "We do not read or monitor students' written answers at scale in v1." `reason` is the one allowlisted
    // key whose writer puts prose in it, and nothing in the type or in `evidence.ts` can see the difference between a
    // browser error name and an essay. A token cannot hold a sentence, so the sentence never reaches the row.
    const verdict = narrowTelemetryDetail({
      reason: 'the mitochondria is the powerhouse of the cell',
    });
    expect(verdict).toEqual({ ok: false, reason: 'DETAIL_VALUE_IS_PROSE', key: 'reason' });
  });

  it("and the writer's own real values still pass, which is what makes this a rule rather than an outage", () => {
    // `watchdog.ts` writes a browser error NAME into `reason`. If the rule rejected that, the fix would be to widen the
    // rule until prose fitted, and the control would be gone. These are the values `evidence.ts` documents.
    for (const value of [
      'AbortError',
      'NotAllowedError',
      'LOAD_TIMEOUT',
      'SIM_LOAD_FAILED',
      'STOP',
      'P1',
    ]) {
      expect(narrowTelemetryDetail({ reason: value }).ok, value).toBe(true);
    }
  });

  it('THE PROPERTY: every one of the five machine-word keys is enforced, and only those five', () => {
    for (const key of MACHINE_WORD_DETAIL_KEYS) {
      const verdict = narrowTelemetryDetail({ [key]: 'a sentence, with spaces and punctuation.' });
      expect(verdict.ok, key).toBe(false);
      if (verdict.ok) throw new Error('expected a refusal');
      expect(verdict.reason, key).toBe('DETAIL_VALUE_IS_PROSE');
    }
    // `simId` holds `mechanics.newtons-cradle` and `peerTabId` is client-chosen, so neither is held to a token shape.
    expect(narrowTelemetryDetail({ simId: 'mechanics.newtons-cradle' }).ok).toBe(true);
    expect(narrowTelemetryDetail({ peerTabId: 'tab-2/with/chars' }).ok).toBe(true);
  });

  it('and the rule is a SHAPE, so a client cannot cost the server a deployment to say a new word', () => {
    // A closed set of allowed words would be a second vocabulary, and it would need a server release before a client could
    // use one. What it would not buy is correctness: nothing reads these words for a decision — the ladder reads a
    // severity and a strike flag from the table — so an unrecognised token is inert.
    expect(isMachineWord('NOT_A_REAL_OUTCOME')).toBe(true);
    expect(isMachineWord('SIM_LOAD_FAILED')).toBe(true);
    expect(isMachineWord('two words')).toBe(false);
    expect(isMachineWord('')).toBe(false);
    expect(isMachineWord('9lives')).toBe(false);
    expect(isMachineWord('x'.repeat(65))).toBe(false);
  });
});

describe('THE ORDINARY CASES', () => {
  it('an absent detail is simply absent, and an empty one is not a lie', () => {
    expect(narrowTelemetryDetail({})).toEqual({ ok: true, detail: {} });
  });

  it('a detail with several legal keys keeps all of them', () => {
    const verdict = narrowTelemetryDetail({ awayForMs: 12, tabWasHidden: true, threshold: 3 });
    expect(verdict).toEqual({
      ok: true,
      detail: { awayForMs: 12, tabWasHidden: true, threshold: 3 },
    });
  });
});
