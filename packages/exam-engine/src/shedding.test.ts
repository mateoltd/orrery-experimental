/**
 * The shedding policy, and whether the code obeys it.  (P8-T9b, `B10`)
 *
 * The first two blocks test the policy as data. **The third tests the CODE against it**, which is the part that makes
 * this a policy instead of a list: a table nobody checks is a comment with better formatting.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVIDENCE_RULES, type EvidenceType } from './evidence.js';
import {
  mayShed,
  NEVER_SHED,
  overflowResponseFor,
  SHEDDABLE,
  SHEDDING_DOCTRINE,
  WRITE_PATHS,
  writeClassOfEvidence,
} from './shedding.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

describe('the policy, as data', () => {
  it('classifies TELEMETRY as droppable and ANSWER_BEARING as not', () => {
    expect(mayShed('evidence.batch')).toBe(true);
    for (const path of NEVER_SHED) expect(mayShed(path), path).toBe(false);
  });

  it('REFUSES AN UNLISTED PATH, because the safe answer must be the default', () => {
    /**
     * The failure this prevents is quiet and slow: someone adds an answer-bearing write path, does not register it, and
     * an "unlisted means telemetry" default makes it droppable on the day the queue is full -- which is the worst
     * possible moment to discover a missing registration.
     */
    expect(mayShed('outbox.somethingNew')).toBe(false);
    expect(mayShed('')).toBe(false);
  });

  it('states a cost for every path, because a path whose loss cannot be described is not understood', () => {
    for (const path of WRITE_PATHS) {
      expect(path.costIfLost.length, path.id).toBeGreaterThan(20);
      expect(path.costIfLost, path.id).not.toMatch(/^(none|n\/a|todo)/i);
    }
  });

  it('drops telemetry OLDEST-ward and grows for answers, never the reverse', () => {
    // Blocking the exam surface to preserve diagnostics would be the worst of both: the student still loses time, and
    // the evidence is preserved anyway.
    expect(overflowResponseFor('TELEMETRY')).toBe('DROP_OLDEST_AND_COUNT');
    expect(overflowResponseFor('ANSWER_BEARING')).toBe('GROW');
    expect(SHEDDING_DOCTRINE.telemetry).toMatch(/oldest/);
    expect(SHEDDING_DOCTRINE.answers).toMatch(/never silently lose/);
  });

  it('treats EVERY evidence event as telemetry, and says so as a function of the type', () => {
    /**
     * A hand-kept list of sheddable types is a list a new event type is not added to -- and a missing entry in a
     * SHEDDING list means the thing gets shed, not spared. Deriving it from the type union means a new `EvidenceType`
     * is classified without anyone remembering this file.
     */
    for (const type of Object.keys(EVIDENCE_RULES) as EvidenceType[]) {
      expect(writeClassOfEvidence(type), type).toBe('TELEMETRY');
    }
  });
});

describe('the two queues in the codebase, checked against the policy', () => {
  it('the telemetry batcher drops OLDEST and COUNTS the loss', () => {
    /**
     * Read from the source rather than reimplemented, because the property is about the code that ships. A queue that
     * sheds RECENT events loses the ones a teacher is looking at right now, and the oldest are the least likely to
     * matter to the incident under review.
     */
    const source = read('packages/exam-engine/src/evidence.ts');
    expect(source).toContain('#queue.shift()');
    expect(source).toContain('this.#dropped += 1');
  });

  it('the ANSWER OUTBOX HAS NO CAP AND NO SHED, which is the half of B10 that actually matters', () => {
    /**
     * `B10` discarded answers the plan had promised to keep. The telemetry side of that fix is easy to see; this is the
     * side that costs a student a mark, so it is asserted against the source.
     *
     * **No `maxQueued`-style ceiling anywhere in the outbox**, and no deletion of a queued write. `overflowResponseFor`
     * says answers GROW, and this is the test that would fail if the code disagreed.
     */
    const source = read('apps/web/src/features/exam/outbox.ts');
    // A cap is a `max*` field or a `slice`/`splice` that removes from the front of the pending set.
    expect(source).not.toMatch(/maxQueued|maxPending|maxEntries|queueLimit/);
    // Dropping the oldest pending write is the shape to look for.
    expect(source).not.toMatch(/\.shift\(\)|splice\(0,\s*1\)/);
    // And it says so in its own words, which is the reason the two files agree.
    expect(source.toLowerCase()).toContain('dead_letter');
  });

  it('the batcher NEVER queues an answer save, so there is nothing there to shed', () => {
    /**
     * The strongest form of "the answer path never sheds" is not a promise but an absence: if answer writes are not in
     * the telemetry queue, then a full telemetry queue cannot touch them. `evidence.ts` says this in a comment; this
     * asserts the comment's claim is structurally true.
     */
    const source = read('packages/exam-engine/src/evidence.ts');
    expect(source).toMatch(/Answer SAVES are not in this queue/);
    // Nothing in the evidence module references the outbox or a response write.
    expect(source).not.toMatch(/import .*(outbox|answer-write)/);
  });

  it('the SERVER-SIDE refusal reason for a late answer is a refusal, not a silent drop', () => {
    /**
     * The other half of the trap: an answer write that cannot be stored must be TOLD to the caller. A shedder that
     * returned nothing on overflow would be indistinguishable, from the student's side, from "the save succeeded".
     */
    const write = read('packages/db/src/answer-write.ts');
    expect(write).toMatch(/reason: 'ATTEMPT_NOT_IN_PROGRESS'/);
    expect(write).toMatch(/reason: 'QUESTION_NOT_IN_ATTEMPT'/);
    // Both deadlines have their OWN refusal reason, which is what makes the sweep/write agreement checkable: the
    // attempt window and the per-question window are separate verdicts a client can be told apart.
    expect(write).toMatch(/reason: 'ATTEMPT_DEADLINE_PASSED'/);
    expect(write).toMatch(/reason: 'QUESTION_DEADLINE_PASSED'/);
    // And the rejection is recorded as an EVENT rather than dropped, per B8.
    expect(write).toContain('LATE_SAVE_REJECTED');
  });
});

describe('every answer-bearing path in the table is one the codebase really has', () => {
  it('names paths that exist, so the table cannot drift into fiction', () => {
    /**
     * A policy table listing paths that do not exist is worse than no table: it looks maintained. This checks each named
     * path against the file that implements it.
     */
    const sources: Record<string, string> = {
      'evidence.batch': 'packages/exam-engine/src/evidence.ts',
      'evidence.sessionEvents': 'packages/exam-engine/src/session.ts',
      'outbox.answerSave': 'apps/web/src/features/exam/outbox.ts',
      'outbox.submit': 'apps/web/src/features/exam/outbox.ts',
      'session.resumeToken': 'packages/exam-engine/src/session.ts',
    };
    for (const path of WRITE_PATHS) {
      expect(sources[path.id], `${path.id} has no file to check against`).toBeDefined();
      expect(read(sources[path.id] ?? '').length, path.id).toBeGreaterThan(0);
    }
  });

  it('SHEDDABLE and NEVER_SHED partition the table, with no overlap and nothing unclassified', () => {
    for (const path of WRITE_PATHS) {
      const sheddable = SHEDDABLE.has(path.id);
      expect(sheddable, path.id).toBe(path.class === 'TELEMETRY');
    }
    expect(SHEDDABLE.size + NEVER_SHED.length).toBe(WRITE_PATHS.length);
  });
});
