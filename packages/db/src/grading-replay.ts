/**
 * Simulation answer replay: re-run the sim's Node grader on a STORED answer, show the trace, override with an audit.  (P9-T7)
 *
 * ## THIS IS A RE-EXECUTION, NOT A REPLAY OF A RESULT, AND THE DIFFERENCE IS THE WHOLE TASK
 *
 * `plans/07` §5.1: "`replay` re-runs the Node grader against stored state and shows the trace". Re-running is what makes
 * the tool worth having: a marker who suspects the grader is wrong can only find out by asking it again. The
 * read-only pane says the opposite and is right to -- `copy.ts:245`, `SIM_REPLAY_NOTE`: "This shows what is stored. It
 * does not re-run the grader, and it does not change the mark." This is the other thing, on a separate surface, behind
 * a separate button, and the copy beside it says so.
 *
 * The proof is not a claim in a comment. `replayedGraderVersion` is the version the CALLER's loader resolved for this
 * call, `storedGraderVersion` is the one on the stored row, and `differsFromStored` is their disagreement about the
 * marks. `grading-replay.test.ts` grades ONE stored answer through two different `loadGrader`s and asserts the marks
 * differ; a module that replayed a stored result could not produce that, because it would have nothing to re-execute.
 *
 * ## AND THE GRADER IS UNTRUSTED CODE, SO THE BOUNDS ARE PART OF THE FEATURE
 *
 * `simulation.ts:255-267` already states the thing that makes this hard: a sim grader is synchronous, so
 * `Promise.race` against a timer cannot interrupt its body, and "the escape is the one this module names and does not
 * perform -- the grader runs in a WORKER THREAD and the CALLER terminates that worker". So there are two bounds, and
 * they are not the same bound:
 *
 *  · **Host-side, and NOT MINE:** a bundle that blocks forever is killed by a worker the caller terminates. No function
 *    in this file can do that, and none of them claims to. `stoppedBy` reports which bound actually applied.
 *  · **Mine, and enforceable here:** everything handed to the bundle is bounded BEFORE the call, everything returned is
 *    bounded after, and the number of concurrent replays is capped. `REPLAY_INPUT_LIMITS` refuses a stored state or
 *    answer too large to grade rather than passing it on -- and it refuses by measuring with a WALK THAT STOPS AT THE
 *    LIMIT, so bounding a 100 MB row costs the bound and not the row. `boundTrace` caps what comes back.
 *
 * The wall-clock budget in between is real and partial: `loadGrader` is the only awaitable step a timer in this process
 * can catch, exactly as `simulation.ts:379-381` says, so `stoppedBy: 'BUDGET'` means the loader ran long, never that a
 * grader loop was interrupted.
 *
 * ## THE OVERRIDE GOES THROUGH `grading-write.ts`, WHICH IS WHY IT CANNOT BE A QUIET LOCAL EDIT
 *
 * `overrideSimReplay` does not write a mark. It calls `bulkGrade`, so the override is subject to the same release gate
 * (`RELEASED_REQUIRES_REGRADE`), the same sealed-automatic refusal, the same optimistic lock and the same atomic
 * `GradeChange` as any other hand mark. An override on a released attempt is therefore impossible without a regrade,
 * and on a healthy sealed auto-grade impossible at all -- which is `plans/07` §5.1 rather than a rule invented here.
 */

import { createHash } from 'node:crypto';

import {
  type DeclaredSurface,
  dispatchToSim,
  type SimGrader,
  type SimOutcome,
  simPublishRefusal,
} from '@orrery/contracts/grading/simulation';

import type { Prisma } from '../prisma/generated/client/client.js';
import type { GradingClock, GradingDb } from './grading-access.js';
import { teacherAttempt } from './grading-access.js';
import { type BoundedTrace, boundTrace } from './grading-replay-trace.js';
import { bulkGrade } from './grading-write.js';

/* ──────────────────────────────────────────────────────── canonical bytes ── */

/**
 * CANONICAL JSON: keys sorted AT EVERY DEPTH, nothing else changed.
 *
 * This is `packages/exam-engine/src/evidence.ts`'s `canonicalJson` in the same shape, and for the same reason, in a
 * second place because that function is not exported and this one measures and hashes rather than signs.
 *
 * ## WHY IT EXISTS HERE, AND WHY IT IS NOT `JSON.stringify`
 *
 * The replay reports a digest of what it graded. `simState` and `answer` came out of `jsonb`, which does NOT preserve
 * key order, so the same answer hashes differently depending on what the database happened to return. That is
 * `ADV-E2` exactly -- "an event stored in `jsonb` and read back verifies as tampered with" -- and it would show up here
 * as a replay of an unchanged answer reporting a changed digest, which a marker would reasonably read as "the student's
 * work changed".
 *
 * ## AND THE BYTES MUST NOT ROUND-TRIP THROUGH `JSON.parse`
 *
 * `evidence-wire.test.ts:93-111` documents the hazard on Node v24.21.0: a one-character key written as an escape comes
 * back as a backslash once an object keyed by a backslash has been parsed, so `JSON.parse(canonical)` is not the same
 * value as the one canonicalised. This function therefore never parses: it walks the value it already holds and emits
 * bytes, and `grading-replay.test.ts` checks those bytes against a serialiser that has also never parsed anything.
 *
 * Keys compare by UTF-16 code unit rather than by locale, for `evidence.ts`'s reason: a collation that differs between
 * two machines is a digest that differs between them.
 */
/**
 * CANONICAL JSON WITH A CEILING, and it is ONE WALK.
 *
 * `buildCanonical` builds the string and `charge` the bytes as it goes, so a document over the ceiling is abandoned
 * partway rather than assembled in full. A measure-then-build version spends the allocation the ceiling exists to
 * prevent, and the test caught it by counting seven characters and getting eight -- the interior was being charged twice,
 * once at the leaf and once again by the level that contained it.
 *
 * `OverBudget` is a sentinel CLASS rather than a return flag, because the walk is recursive and a flag would have to be
 * threaded through every arm. The first version returned a flag and walked to the end of an oversized state before
 * noticing, which is the specific cost the ceiling was introduced to avoid.
 */
class OverBudget extends Error {
  constructor() {
    super('over budget');
  }
}

export interface MeasuredInput {
  /** Canonical JSON, or `null` when the walk hit `limit` and stopped. The two are not interchangeable: `null` means "over". */
  readonly canonical: string | null;
  /** Canonical length when under the limit; `limit + 1` when over, which is the honest answer to "how big is it". */
  readonly bytes: number;
}

const buildCanonical = (value: unknown, ceiling: number): { canonical: string; bytes: number } => {
  const counter = { chars: 0 };
  /**
   * THE SIZE IS CHARGED IN PIECES, NOT PER LEVEL.
   *
   * Each level charges only what IT contributed -- its braces or brackets, its commas, and a key plus its colon -- and
   * each leaf charges its own encoding. The first version subtracted each level's WHOLE encoded length as it returned,
   * which counted every interior twice and reported `bytes: 8` for `{"a":1}`. A bound that over-reports refuses values
   * that fit, and the trace ceiling is applied per entry, so an off-by-one would silently drop entries from every long
   * session rather than showing up as a rejected document.
   */
  const charge = (chars: number): void => {
    counter.chars += chars;
    if (counter.chars > ceiling) throw new OverBudget();
  };
  const walk = (node: unknown): string => {
    if (node === null || typeof node !== 'object') {
      const encoded = JSON.stringify(node ?? null) ?? 'null';
      charge(encoded.length);
      return encoded;
    }
    if (Array.isArray(node)) {
      charge(2);
      const items = node.map((item, index) => {
        if (index > 0) charge(1);
        return walk(item);
      });
      return `[${items.join(',')}]`;
    }
    const entries = Object.entries(node as Record<string, unknown>)
      // `undefined` dropped, because `JSON.stringify` drops it anyway and two implementations disagreeing about whether
      // a key exists would produce two digests for one answer.
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    charge(2);
    return `{${entries
      .map(([key, inner], index) => {
        if (index > 0) charge(1);
        const quoted = JSON.stringify(key);
        charge(quoted.length + 1);
        return `${quoted}:${walk(inner)}`;
      })
      .join(',')}}`;
  };
  return { canonical: walk(value), bytes: counter.chars };
};

/**
 * MEASURE A STORED DOCUMENT AGAINST A CEILING, AND STOP WHEN IT IS OVER.
 *
 * ## WHY THE WALK ABORTS INSTEAD OF COUNTING EVERYTHING
 *
 * The ceiling exists because a `jsonb` row can be arbitrarily large and the grader must not be handed an unbounded
 * document. Measuring a 100 MB row in full to discover it is over the limit spends the memory the limit was protecting.
 *
 * One walk, not two: a cheap upper bound followed by a full canonicalisation would be two passes over the same value,
 * and the second is the expensive one.
 *
 * ## AND `bytes` IS EXACT WHEN THE WALK COMPLETES, WHICH IS WHAT A BOUND NEEDS
 *
 * An off-by-one here is not cosmetic. A bound that over-reports refuses a value that fits, and the trace ceiling is
 * applied per entry, so a systematic over-count would silently drop entries from every long session. `{"a":1}` is SEVEN
 * characters and this returns seven.
 */
export const measureWithin = (value: unknown, limit: number): MeasuredInput => {
  const ceiling = Math.max(1, Math.floor(limit));
  try {
    const measured = buildCanonical(value, ceiling);
    return { canonical: measured.canonical, bytes: measured.bytes };
  } catch (error) {
    if (error instanceof OverBudget) return { canonical: null, bytes: ceiling + 1 };
    throw error;
  }
};

/**
 * THE DIGEST OF WHAT WAS GRADED, so a replay says WHICH bytes produced its verdict.
 *
 * Byte-exact by construction: the canonical form is what the digest is taken over, and the canonical form is
 * order-independent. Two replays of the same stored answer on the same grader version produce the same digest whether
 * the database returned the object in a different key order the second time or not.
 */
export const inputDigest = (canonical: string): string =>
  createHash('sha256').update(canonical).digest('hex');

/* ────────────────────────────────────────────────────────── the resource bounds ── */

/**
 * WHAT MAY BE HANDED TO THE BUNDLE, in characters of canonical JSON.
 *
 * The sizes sit just ABOVE the platform's own limits rather than at them. B15 records a 64 KB cap on inline
 * `simState` with oversize states in `SimStateBlob`, and `plans/10` §9 caps a sim bundle at 1.2 MB; 64 KB of state and
 * 8 KB of reported answer are therefore the sizes the platform already believes it produces. A row larger than that is
 * a legacy row, a hand-edited one, or a bundle that ignored the protocol -- and in every case it is not something to
 * hand to third-party code on an exam server.
 *
 * `maxTraceChars` is the ceiling on the DOCUMENT a `PATH_SENSITIVE` grader reads, which is the one input whose length
 * is chosen entirely by the sim. 256 KB is generous for a bounded interaction trace and small enough that copying it
 * across the worker boundary is not the expensive part of the request.
 */
export const REPLAY_INPUT_LIMITS = {
  maxStateChars: 65_536,
  maxAnswerChars: 8_192,
  maxTraceChars: 262_144,
} as const;

/** The default wall-clock budget for a replay. The host may pass another; the number lives here to be cited. */
export const REPLAY_DEFAULT_BUDGET_MS = 5_000;

/**
 * HOW MANY REPLAYS MAY BE IN FLIGHT AT ONCE, per process.
 *
 * Every replay occupies a worker thread for as long as its bundle runs, and `simulation.ts:260-267` establishes that the
 * bundle may run for as long as it likes. So the number of concurrent replays is the number of threads this process can
 * be made to occupy, and a marker with six replay panes in six tabs has found that vector.
 *
 * **ADMISSION IS REFUSED, NOT QUEUED.** A queue in front of an unbounded job is a queue that grows without limit, which
 * is the same denial of service wearing a coat. A refused replay is also an honest outcome rather than a 500: the
 * response carries `NEEDS_HUMAN/GRADER_TIMED_OUT`, because `INV-SIM-2` gives a technical failure two possible results
 * and one of them is a zero.
 *
 * The gate is module state on purpose -- it counts work in this process, and a per-call gate would count nothing. It is
 * process-wide rather than per-user on purpose too: the resource is a thread, not a mark, and one marker must not be
 * able to lock out another.
 */
export const REPLAY_MAX_CONCURRENT = 8;

export interface ReplayAdmission {
  /** `false` when the limit is reached. Never throws: a refusal here must be a marker's message, not a 500. */
  admit: () => boolean;
  /** Called in a `finally`, so a rejected replay does not leak a slot. */
  release: () => void;
}

export const createReplayAdmission = (limit: number): ReplayAdmission => {
  let held = 0;
  return {
    admit: () => {
      if (held >= limit) return false;
      held += 1;
      return true;
    },
    release: () => {
      held = Math.max(0, held - 1);
    },
  };
};

const processAdmission = createReplayAdmission(REPLAY_MAX_CONCURRENT);

/* ───────────────────────────────────────────────────────────────── the replay ── */

export interface SimReplayHooks {
  /**
   * THE ONLY WAY UNTRUSTED CODE ENTERS THIS MODULE.
   *
   * It is the caller's because where a bundle lives is a deployment fact (a registry read, a dynamic import, a mirror),
   * and because the version it resolves IS the evidence the replay reports. A replay pinned to the stored `simVersion`
   * answers "what did we do then"; a replay against `compareGraderVersion` answers "what would we do now", which is
   * the question behind "has the grader changed since".
   */
  loadGrader: (simId: string, simVersion: string) => Promise<SimGrader>;
  /** Validates the stored state against the sim's declared `stateSchema`. A failure is never a zero (`INV-SIM-2`). */
  validateState: (simId: string, simVersion: string, state: unknown) => boolean;
  /** Reads an oversize state out of object storage when `simStateRef` is set instead of `simState`. */
  readStateBlob: (ref: string) => Promise<unknown>;
  /** Milliseconds before the replay is abandoned. Defaults to `REPLAY_DEFAULT_BUDGET_MS`. */
  budgetMs?: number;
  /** Re-runs a DIFFERENT version, so a marker can ask what a newer grader would have said. */
  compareGraderVersion?: string;
  /** Overrides the process-wide concurrency gate. Tests supply one; a host with its own pool accounting may too. */
  admission?: ReplayAdmission;
}

export interface SimReplayQuery {
  readonly actorId: string;
  readonly responseId: string;
}

/** The stored automatic decision. `manualScore` is deliberately NOT selected: a replay reads the grader, not a hand mark. */
export interface StoredAutomaticGrade {
  readonly points: number | null;
  readonly rawPoints: number | null;
  readonly version: string | null;
  readonly needsHuman: boolean;
}

export type SimReplayRefusal =
  | 'NOT_A_SIMULATION'
  | 'STATE_TOO_LARGE'
  | 'ANSWER_TOO_LARGE'
  | 'ADMISSION_REFUSED';

export interface SimReplay {
  readonly responseId: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly simId: string;
  /** The version whose bundle produced `outcome`. This is what makes the replay auditable rather than decorative. */
  readonly replayedGraderVersion: string;
  /** The version that produced `stored`, or null when nothing was graded. */
  readonly storedGraderVersion: string | null;
  readonly outcome: SimOutcome;
  readonly trace: BoundedTrace;
  readonly stored: StoredAutomaticGrade;
  /** True when the re-run and the stored figure disagree. The observable proof this is a re-execution. */
  readonly differsFromStored: boolean;
  /**
   * WHAT WAS HANDED TO THE BUNDLE, so a marker reading a surprising verdict can see how much of the answer it actually
   * received. `traceDropped > 0` means the grader read a shorter trace than the student produced, which changes what
   * its verdict is evidence OF -- so it is on the DTO for the screen to render rather than swallowed here.
   */
  readonly inputs: {
    /** Canonical characters of the state. `null` when it was over the ceiling, which is also why it was not graded. */
    readonly stateChars: number | null;
    readonly answerChars: number | null;
    readonly traceChars: number;
    readonly traceSupplied: number;
    readonly traceDropped: number;
    readonly fromBlob: boolean;
  };
  /** SHA-256 of the canonical bytes actually graded, so the replay says WHICH answer produced the verdict. */
  readonly gradedInputDigest: string | null;
  /** Which bound applied, or null when the replay ran to the grader. See the header on why none of them is total. */
  readonly stoppedBy: 'INPUT_LIMIT' | 'ADMISSION' | 'BUDGET' | null;
  readonly refusal: SimReplayRefusal | null;
  /**
   * WHEN IT RAN, from the injected clock.
   *
   * `INV-TIME-1` forbids `Date.now()` in this repository, and it is worth more than a convention here: the replay is the
   * evidence a marker produces, and a marker reading it weeks later is entitled to know whether the grader they are
   * looking at is the one that was registered then.
   */
  readonly replayedAt: string;
}

type SimTechnicalReason = Extract<SimOutcome, { kind: 'NEEDS_HUMAN' }>['reason'];

/**
 * A TECHNICAL OUTCOME, which is one of `INV-SIM-2`'s two outcomes and never a mark.
 *
 * Named `NEEDS_HUMAN` because the alternative is the bug the invariant is named for: a zero is indistinguishable, in a
 * release batch, from a wrong answer, and a marker seeing a run of zeros would mark them wrong.
 */
const needsHuman = (reason: SimTechnicalReason, detail: string): SimOutcome => ({
  kind: 'NEEDS_HUMAN',
  reason,
  detail,
});

/**
 * THE STORED ANSWER, split into the two things the sim's grader reads, plus the trace.
 *
 * ## THE ENVELOPE IS THE SIM'S OWN, AND THERE IS NO COLUMN FOR A TRACE
 *
 * `packages/contracts/src/grading/paper.ts:141-146` records that a simulation's response is `{ simState, answer }`,
 * written by a third-party bundle and round-tripped through `postMessage`, an outbox and a `jsonb` column. The state
 * has a pointer column (`QuestionResponse.simStateRef`, `schema.prisma:1362`) because B15 moved oversize states to S3.
 * The interaction trace has no column at all and therefore rides inside the same envelope, written by whatever the
 * bundle put there -- so it is read defensively, and an envelope whose `trace` is not an array yields a trace of zero
 * entries and a disclosed `traceDropped`, rather than a throw inside a marker's session.
 */
const readStoredSimAnswer = (
  answer: Prisma.JsonValue,
): { simState: unknown; reported: unknown; trace: readonly unknown[] } => {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer))
    return { simState: null, reported: answer, trace: [] };
  const envelope = answer as Record<string, unknown>;
  // Literal keys, not `envelope['simState']`: the envelope is `Record<string, unknown>`, and biome's `useLiteralKeys`
  // is right that the brackets say "this might be absent" when the code right below already says so with `?? null`.
  return {
    simState: envelope.simState ?? null,
    reported: envelope.answer ?? null,
    trace: Array.isArray(envelope.trace) ? (envelope.trace as readonly unknown[]) : [],
  };
};

/** The points a re-run produced, or null when it produced none. `null` against a number is a disagreement. */
const replayedPointsOf = (outcome: SimOutcome): number | null =>
  outcome.kind === 'GRADED' ? outcome.points : null;

/**
 * RE-RUN THE SIM'S GRADER ON A STORED ANSWER.
 *
 * One database read, one dispatch, one bounded result. **No writes of any kind**: a replay that could move a mark would
 * be an override wearing a replay's name, and `overrideSimReplay` is the separate, audited, policy-gated path. `null`
 * means the response is not this teacher's to read, or is not a simulation -- the caller shows nothing either way, so a
 * marker cannot use the difference to probe another classroom's rows.
 */
export async function replaySimAnswer(
  db: GradingDb,
  query: SimReplayQuery,
  hooks: SimReplayHooks,
  clock: GradingClock,
): Promise<SimReplay | null> {
  const row = await db.$transaction(
    async (tx) =>
      tx.questionResponse.findFirst({
        where: { id: query.responseId, attempt: teacherAttempt(query.actorId) },
        select: {
          id: true,
          attemptId: true,
          questionId: true,
          answer: true,
          simState: true,
          simStateRef: true,
          autoScore: true,
          autoRawScore: true,
          autoGraderVersion: true,
          needsHuman: true,
          question: {
            select: {
              type: true,
              simId: true,
              simVersion: true,
              scoringSurface: true,
              simConfig: true,
            },
          },
        },
      }),
    { timeout: 20_000 },
  );
  if (!row) return null;
  if (row.question.type !== 'simulation') return null;
  if (!row.question.simId || !row.question.simVersion) return null;

  const simId = row.question.simId;
  const pinnedVersion = row.question.simVersion;
  const replayVersion = hooks.compareGraderVersion ?? pinnedVersion;
  const envelope = readStoredSimAnswer(row.answer);
  const stored: StoredAutomaticGrade = {
    points: row.autoScore === null ? null : Number(row.autoScore),
    rawPoints: row.autoRawScore === null ? null : Number(row.autoRawScore),
    version: row.autoGraderVersion,
    needsHuman: row.needsHuman,
  };
  const base = {
    responseId: row.id,
    attemptId: row.attemptId,
    questionId: row.questionId,
    simId,
    replayedGraderVersion: replayVersion,
    storedGraderVersion: stored.version,
    stored,
  };
  const replayedAt = new Date(clock.now()).toISOString();
  const emptyInputs = {
    stateChars: null,
    answerChars: null,
    traceChars: 0,
    traceSupplied: 0,
    traceDropped: envelope.trace.length,
    fromBlob: row.simStateRef !== null,
  };

  /**
   * THE DECLARED SCORING SURFACE IS CHECKED BEFORE ANYTHING IS MEASURED.
   *
   * `simPublishRefusal` is the same call `dispatchToSim` makes first (`simulation.ts:270`), and running it here means a
   * question with no declared surface is reported as the authoring defect it is rather than as a state that happened to
   * be too big. `V-11`: an unguarded sim item measures parameter-space search, and that is a publishing decision.
   */
  const spec = {
    simId,
    simVersion: replayVersion,
    scoringSurface: (row.question.scoringSurface ?? null) as DeclaredSurface,
    params: (row.question.simConfig as Record<string, unknown> | null) ?? undefined,
  };
  const surfaceRefusal = simPublishRefusal(spec);
  if (surfaceRefusal !== null)
    return {
      ...base,
      outcome: needsHuman('NO_SCORING_SURFACE', surfaceRefusal),
      trace: boundTrace(envelope.trace),
      differsFromStored: false,
      inputs: emptyInputs,
      gradedInputDigest: null,
      stoppedBy: null,
      refusal: 'NOT_A_SIMULATION',
      replayedAt,
    };

  /**
   * THE INPUT BOUNDS, MEASURED BEFORE THE BUNDLE IS ASKED FOR.
   *
   * A refusal here is `NEEDS_HUMAN`, never a mark and never a truncation. Handing a grader a state we have shortened is
   * grading something the student never submitted, which is the same defect as a state that fails its schema.
   *
   * ## AND THE STATE IS READ FROM THREE PLACES, IN THIS ORDER
   *
   * `QuestionResponse.simState` is the fast path; `simStateRef` is B15's pointer for a state too big to inline; and the
   * ENVELOPE is the third source, because `packages/contracts/src/grading/paper.ts:141-146` records a simulation's
   * response as `{ simState, answer }` "written by a third-party bundle and round-tripped through `postMessage`, an
   * outbox and a `jsonb` column" -- so the state can be in the envelope with the column left null.
   *
   * The first version read only the column and handed the grader `null`. It reported a real grade, from the real bundle,
   * about a state the student never had, and every test that only asserted "a grade came back" passed. The integration
   * test caught it by asserting the state SIZE and getting 4 characters for `{"burn":3}` -- which is the argument for
   * putting the measured input on the DTO at all rather than in a log line.
   */
  const state =
    row.simStateRef !== null
      ? await hooks.readStateBlob(row.simStateRef)
      : (row.simState ?? envelope.simState);
  const measuredState = measureWithin(state, REPLAY_INPUT_LIMITS.maxStateChars);
  if (measuredState.canonical === null)
    return {
      ...base,
      outcome: needsHuman(
        'GRADER_UNREADABLE',
        `the stored state is above the ${String(REPLAY_INPUT_LIMITS.maxStateChars)} characters a grader may be handed, so it was not graded`,
      ),
      trace: boundTrace(envelope.trace),
      differsFromStored: false,
      inputs: { ...emptyInputs, stateChars: null },
      gradedInputDigest: null,
      stoppedBy: 'INPUT_LIMIT',
      refusal: 'STATE_TOO_LARGE',
      replayedAt,
    };

  const measuredAnswer = measureWithin(envelope.reported, REPLAY_INPUT_LIMITS.maxAnswerChars);
  if (measuredAnswer.canonical === null)
    return {
      ...base,
      outcome: needsHuman(
        'GRADER_UNREADABLE',
        `the stored answer is above the ${String(REPLAY_INPUT_LIMITS.maxAnswerChars)} characters a grader may be handed, so it was not graded`,
      ),
      trace: boundTrace(envelope.trace),
      differsFromStored: false,
      inputs: { ...emptyInputs, stateChars: measuredState.bytes },
      gradedInputDigest: null,
      stoppedBy: 'INPUT_LIMIT',
      refusal: 'ANSWER_TOO_LARGE',
      replayedAt,
    };

  /**
   * THE TRACE IS CUT TO ITS CEILING AND THE CUT IS COUNTED IN THE RESULT.
   *
   * Not refused: a `PATH_SENSITIVE` grader reading a shorter trace still produces a real grade, and refusing every long
   * session would make the tool useless on exactly the questions it exists for. So it is DISCLOSED -- `traceDropped` is on
   * the DTO for the screen to render, because a verdict computed on a shortened trace is a verdict about a document the
   * marker is not being shown in full.
   */
  let traceChars = 0;
  let traceSupplied = 0;
  for (const entry of envelope.trace) {
    // The remaining budget is the per-entry ceiling, so a thousand-entry trace costs one walk of the budget rather
    // than a thousand walks of the whole ceiling.
    const size = measureWithin(entry, REPLAY_INPUT_LIMITS.maxTraceChars - traceChars).bytes;
    if (traceChars + size > REPLAY_INPUT_LIMITS.maxTraceChars) break;
    traceChars += size;
    traceSupplied += 1;
  }
  const traceForGrader = envelope.trace.slice(0, traceSupplied);
  const inputs = {
    stateChars: measuredState.bytes,
    answerChars: measuredAnswer.bytes,
    traceChars,
    traceSupplied,
    traceDropped: envelope.trace.length - traceSupplied,
    fromBlob: row.simStateRef !== null,
  };
  /**
   * THE DIGEST COVERS THE GRADER'S ACTUAL INPUT, INCLUDING THE CUT TRACE AND NOT INCLUDING THE REST.
   *
   * Otherwise the digest would describe a document the grader never saw, which is the one thing a digest must not do.
   */
  const gradedInputDigest = inputDigest(
    buildCanonical(
      { simId, simVersion: replayVersion, state, answer: envelope.reported, trace: traceForGrader },
      // The digest's own ceiling, separate from the per-document ceilings above: it is a string we already hold, not a
      // document we fetched, so bounding it against a grader's input limit would be bounding the wrong thing. The
      // components are ALREADY bounded by `measuredState`, `measuredAnswer` and `traceForGrader`, so this can only be
      // their sum -- and the digest is taken over the RAW `state` and `envelope.reported`, not their canonical strings,
      // because re-canonicalising a canonical string would quote it again and produce a different digest.
      Number.MAX_SAFE_INTEGER,
    ).canonical,
  );

  const admission = hooks.admission ?? processAdmission;
  if (!admission.admit())
    return {
      ...base,
      outcome: needsHuman(
        'GRADER_TIMED_OUT',
        `${String(REPLAY_MAX_CONCURRENT)} simulation replays are already running here, so this one was not started`,
      ),
      trace: boundTrace(envelope.trace),
      differsFromStored: false,
      inputs,
      gradedInputDigest,
      stoppedBy: 'ADMISSION',
      refusal: 'ADMISSION_REFUSED',
      replayedAt,
    };

  const budgetMs = hooks.budgetMs ?? REPLAY_DEFAULT_BUDGET_MS;
  try {
    const outcome = await dispatchToSim({
      spec,
      state,
      answer: envelope.reported,
      trace: traceForGrader,
      loadGrader: hooks.loadGrader,
      validateState: hooks.validateState,
      timeoutMs: budgetMs,
    });
    return {
      ...base,
      outcome,
      trace: boundTrace(envelope.trace),
      differsFromStored: replayedPointsOf(outcome) !== stored.points,
      inputs,
      gradedInputDigest,
      stoppedBy:
        outcome.kind === 'NEEDS_HUMAN' && outcome.reason === 'GRADER_TIMED_OUT' ? 'BUDGET' : null,
      refusal: null,
      replayedAt,
    };
  } finally {
    // In a `finally`, so a grader that threw still gives its slot back. A leaked slot is a denial of service that
    // looks exactly like a busy server.
    admission.release();
  }
}

/* ──────────────────────────────────────────────────────────────── the override ── */

export const SIM_REPLAY_OVERRIDE = 'SIM_REPLAY_OVERRIDE';
export const SIM_REPLAY_OVERRIDE_TARGET = 'QuestionResponse';

/** `plans/07` §3.4 caps a feedback comment at 10,000 characters; an override reason is a sentence and needs less. */
export const SIM_OVERRIDE_REASON_MAX_CHARS = 2_000;

export type OverrideRefusal =
  | 'NOT_FOUND'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'INVALID_POINTS'
  /** A healthy sealed auto-grade. A hand mark is refused, and the assignment-wide regrade is the answer. */
  | 'SEALED_REQUIRES_KEY_FLAG'
  /** Released, or being released. `INV-RELEASE-1`: a published figure moves only by regrade, with a notice. */
  | 'RELEASED_REQUIRES_REGRADE'
  | 'RELEASE_IN_PROGRESS'
  | 'RELEASE_MEMBERSHIP_CHANGED'
  | 'CONFLICT'
  | 'NOT_REVIEWABLE';

export interface SimOverrideInput {
  readonly actorId: string;
  readonly clock: GradingClock;
  readonly responseId: string;
  /** The revision the marker was looking at. Somebody else's mark wins over this one. */
  readonly basedOn: string;
  readonly points: number;
  readonly reason: string;
  /** The replay this override came from, so the audit names the version whose verdict was disagreed with. */
  readonly replayedGraderVersion: string;
  readonly replayedPoints: number | null;
}

export type SimOverrideResult =
  | { readonly ok: true; readonly revision: string }
  | { readonly ok: false; readonly reason: OverrideRefusal; readonly awaitingHuman: boolean };

/**
 * OVERRIDE A SIMULATION'S MARK BY HAND, WITH AN AUDIT THAT CAN NEVER BE CONFUSED WITH THE GRADER'S OUTPUT.
 *
 * ## WHY THE AUDIT ROW IS WRITTEN FIRST
 *
 * The order is the guarantee. `bulkGrade` opens its own transaction, so the mark and this row cannot share one without
 * forking `grading-write.ts` -- which the brief says not to do, and for good reason: the release locks, the optimistic
 * lock, the sealed-automatic refusal and the atomic `GradeChange` are all inside it. So the row that classifies the mark
 * is written FIRST, as an INTENT carrying its reasoning.
 *
 * A mark can then only land when its intent is already on record. What this trades away is an intent row with no mark
 * behind it -- which is TRUE (a marker tried this and it did not take), visible to the next reader, and strictly better
 * than the reverse: an override that landed with nothing recording where it came from, which is an undetectable manual
 * mark change and the exact thing `GradeChange` exists to make impossible for ordinary marking.
 *
 * ## AND THE THREE THINGS THAT MAKE IT DISTINGUISHABLE FROM A GRADER RESULT
 *
 *  1. **`manualScore` beside `autoScore`.** `computeScore` reads `manualScore ?? autoScore`
 *     (`grading-regrade.ts:269`), so the override takes effect and the grader's own figure SURVIVES next to it. A later
 *     regrade recomputes `autoScore` and leaves `manualScore` alone, so both readings remain answerable. On its own this
 *     does NOT say the mark was an override: a rubric band and a keyboard shortcut produce the same shape.
 *  2. **`GradeChange`.** `bulkGrade` writes `{before, after, reason, actorId, createdAt}` in the same transaction as the
 *     mark, so who / when / old / new are atomic with it rather than reconstructed from a log that might arrive late.
 *  3. **The `SIM_REPLAY_OVERRIDE` row in `AuditEvent`,** whose `meta` names the grader version whose verdict was
 *     disagreed with and the points the replay proposed. That is the discriminator, and it is queryable by action for
 *     as long as the row survives.
 *
 * ## AND WHAT THIS DOES *NOT* CLAIM, WHICH THE FIRST DRAFT OF THIS COMMENT DID
 *
 * The first draft promised a third thing: an `AttemptEventRecord` carrying `payload.source = 'SIM_REPLAY_OVERRIDE'`. It
 * is not available, and the integration test is what proved it. `bulkGrade` writes its own `MANUAL_GRADED` event with
 * `payload = { action, responseId, basedOn, reason }` (`grading-write.ts:222-231`) and there is no `source` key to fill.
 * Getting one would mean forking `bulkGrade` -- which the brief forbids, and which would duplicate the release locks, the
 * optimistic lock and the atomic `GradeChange` -- or writing a SECOND `MANUAL_GRADED` event, which puts two rows for one
 * action in an append-only history and makes that history harder to read than it was.
 *
 * So the discriminator is the audit row, and the cost is stated rather than hidden: someone reading only the attempt
 * timeline sees `MANUAL_GRADED` and has to ask the audit log whether it was a replay. One extra query. Not an
 * undetectable change.
 */
export async function overrideSimReplay(
  db: GradingDb,
  input: SimOverrideInput,
): Promise<SimOverrideResult> {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, reason: 'REASON_REQUIRED', awaitingHuman: false };
  if (input.reason.length > SIM_OVERRIDE_REASON_MAX_CHARS)
    return { ok: false, reason: 'REASON_TOO_LONG', awaitingHuman: false };

  /**
   * READ THE OLD VALUE WITH THE REVISION, IN ONE QUERY.
   *
   * The revision goes to `bulkGrade` as `basedOn`, so the optimistic lock decides whether what was read here is what the
   * mark replaced: on success it provably is, and on `CONFLICT` nothing is written and the old value is never used.
   * That is what makes it safe to read outside `bulkGrade`'s transaction rather than duplicating its locks to read
   * inside one.
   */
  const before = await db.$transaction(
    async (tx) =>
      tx.questionResponse.findFirst({
        where: { id: input.responseId, attempt: teacherAttempt(input.actorId) },
        select: {
          id: true,
          attemptId: true,
          revision: true,
          needsHuman: true,
          manualScore: true,
          attempt: { select: { assignmentId: true, classroomId: true } },
        },
      }),
    { timeout: 20_000 },
  );
  if (!before) return { ok: false, reason: 'NOT_FOUND', awaitingHuman: false };
  if (input.basedOn !== String(before.revision))
    return { ok: false, reason: 'CONFLICT', awaitingHuman: before.needsHuman };

  const at = new Date(input.clock.now());
  await db.$transaction(
    async (tx) => {
      await tx.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: SIM_REPLAY_OVERRIDE,
          targetType: SIM_REPLAY_OVERRIDE_TARGET,
          targetId: before.id,
          classroomId: before.attempt.classroomId,
          meta: {
            assignmentId: before.attempt.assignmentId,
            responseId: before.id,
            attemptId: before.attemptId,
            reason,
            oldPoints: before.manualScore === null ? null : Number(before.manualScore),
            newPoints: input.points,
            replayedGraderVersion: input.replayedGraderVersion,
            replayedPoints: input.replayedPoints,
            basedOnRevision: input.basedOn,
          },
          createdAt: at,
        },
      });
    },
    { timeout: 20_000 },
  );

  /**
   * `quickScored: false` ALWAYS. `plans/07` §3.6 samples quick-scored responses for moderation because a mark entered at
   * 10 s a paper is less reliable than one entered at 90 s. An override taken from a re-run grader is the opposite case,
   * and recording it as quick-scored would put it in the moderation sample for the wrong reason.
   */
  const saved = await bulkGrade(db, {
    actorId: input.actorId,
    clock: input.clock,
    action: { kind: 'SCORE', points: input.points, feedback: '', quickScored: false },
    targets: [{ attemptId: before.attemptId, responseId: before.id, basedOn: input.basedOn }],
  });
  if (saved.ok)
    return { ok: true, revision: saved.saved[0]?.version ?? String(before.revision + 1) };
  if (saved.reason === 'NOT_FOUND')
    return { ok: false, reason: 'NOT_FOUND', awaitingHuman: before.needsHuman };
  return { ok: false, reason: mapRefusal(saved.reason), awaitingHuman: before.needsHuman };
}

/**
 * `grading-write.ts`'s refusal vocabulary, restated on this feature's terms.
 *
 * `SEALED_AUTOMATIC` becomes `SEALED_REQUIRES_KEY_FLAG` because that is the action it actually points at, and a marker
 * shown the name of an internal constant is a marker shown nothing. `plans/07` §5.1 is explicit that a sealed
 * auto-grade is not editable inline and that the alternative is the reviewed, assignment-wide regrade -- which is
 * `grading-review.ts`'s flag.
 *
 * The `default` arm is a refusal rather than a pass: an unrecognised reason from `bulkGrade` must not become a success.
 */
const mapRefusal = (reason: string): OverrideRefusal => {
  switch (reason) {
    case 'SEALED_AUTOMATIC':
      return 'SEALED_REQUIRES_KEY_FLAG';
    case 'INVALID_SCORE':
      return 'INVALID_POINTS';
    case 'RELEASED_REQUIRES_REGRADE':
    case 'RELEASE_IN_PROGRESS':
    case 'RELEASE_MEMBERSHIP_CHANGED':
    case 'CONFLICT':
    case 'NOT_REVIEWABLE':
    case 'REASON_REQUIRED':
    case 'NOT_FOUND':
      return reason;
    default:
      return 'NOT_REVIEWABLE';
  }
};
