/**
 * The evidence pipeline: the closed event schema, strike classification, and batch signing.  (P8-T7)
 *
 * ## WHY THE EVENT TABLE IS CODE AND NOT A DATABASE LOOKUP
 *
 * `plans/09` §7.1 gives every event a severity and says whether it counts as a strike. Four entries in that table are
 * not about the student at all, and each of them can be turned into an accusation by accident:
 *
 *  · `FULLSCREEN_DENIED` — "a capability failure, not misconduct". A locked-down school device denies fullscreen.
 *  · `DEVTOOLS_SIZE_ANOMALY` — "advisory evidence only, never punitive". Window size is not evidence of anything.
 *  · `SIM_LOAD_FAILED` — "**never penalises the student for our bug**".
 *  · `ACCOMMODATION_RELAXED` — never, under INV-ACC-1.
 *
 * Those four are the reason the table lives here as data with the strike decision made in one function. A severity
 * looked up per call site is a severity somebody eventually gets wrong, and the consequence is a strike against a
 * student for a browser policy.
 *
 * ## AND WHY `VIOLATION_THRESHOLD_REACHED` CANNOT BE EMITTED FROM HERE
 *
 * §7.1 marks it "emitted by the **server**". A client that emitted it would be announcing its own escalation, on
 * evidence it holds and a teacher has not seen, and the ladder would act on the client's count. So it is in the schema
 * as a known type and is REJECTED by the writer, because the type has to exist for the server's rows to be readable.
 */

import type { Millis } from '@orrery/clock';

/** Every event type in `plans/09` §7.1, plus the ones the server emits. */
export type EvidenceType =
  | 'EXAM_STARTED'
  | 'FULLSCREEN_ENTERED'
  | 'FULLSCREEN_EXITED'
  | 'FULLSCREEN_DENIED'
  | 'POINTERLOCK_ENTERED'
  | 'POINTERLOCK_LOST'
  | 'WINDOW_BLURRED'
  | 'WINDOW_FOCUSED'
  | 'TAB_HIDDEN'
  | 'TAB_VISIBLE'
  | 'MULTI_TAB_DETECTED'
  | 'COPY_ATTEMPT'
  | 'PASTE_ATTEMPT'
  | 'CONTEXT_MENU'
  | 'PRINT_ATTEMPT'
  | 'SAVE_ATTEMPT'
  | 'DEVTOOLS_SIZE_ANOMALY'
  | 'SAVE_REJECTED_LATE'
  | 'QUESTION_WINDOW_CLOSED'
  | 'CLOCK_SKEW_DETECTED'
  | 'NETWORK_LOST'
  | 'NETWORK_RESTORED'
  | 'AUTOSAVE_QUEUED'
  | 'SIM_LOAD_FAILED'
  | 'ACCOMMODATION_RELAXED'
  | 'VIOLATION_THRESHOLD_REACHED'
  | 'ATTEMPT_TERMINATED'
  | 'ATTEMPT_SUBMITTED';

export type Severity = 'INFO' | 'WARN' | 'VIOLATION';

/**
 * HOW EACH EVENT IS TREATED, and the four that are not about the student.
 *
 * `strike: 'never'` is a stronger statement than `strike: 'no'`, and the distinction is deliberate:
 *
 *  · `'no'` -- this event does not increment a counter. It can still be shown.
 *  · `'never'` -- this event must NEVER affect a student's outcome under any policy. It is evidence about the
 *    software, the browser or an accommodation, and `plans/09` says so in as many words for three of them.
 */
export interface EventRule {
  readonly severity: Severity;
  readonly strike: 'never' | 'when_fullscreen_required' | 'when_policy_says' | 'always';
  readonly why: string;
}

/**
 * THE CLOSED TABLE.
 *
 * `as const` so a missing row is a type error rather than an `undefined` that reads as "no strike".
 */
export const EVIDENCE_RULES: Readonly<Record<EvidenceType, EventRule>> = Object.freeze({
  EXAM_STARTED: { severity: 'INFO', strike: 'never', why: 'carries the preflight record' },
  FULLSCREEN_ENTERED: { severity: 'INFO', strike: 'never', why: 'the deterrent working' },
  FULLSCREEN_EXITED: {
    severity: 'VIOLATION',
    strike: 'when_fullscreen_required',
    why: 'counts only when the policy required fullscreen',
  },
  // "A capability failure, not misconduct" -- `plans/09` §7.1. A locked-down device denies fullscreen.
  FULLSCREEN_DENIED: {
    severity: 'WARN',
    strike: 'never',
    why: 'a capability failure, not misconduct: the browser refused and the student is not at fault',
  },
  POINTERLOCK_ENTERED: { severity: 'INFO', strike: 'never', why: 'the deterrent working' },
  // "only past grace, and only if policy says so" -- and `Escape` always causes this, which is why the grace exists.
  POINTERLOCK_LOST: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'past grace only, and Escape always causes it, so it is a deterrent and not a lock',
  },
  WINDOW_BLURRED: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'thresholded, not per-event: one click on another window is not an offence, so only the count matters',
  },
  WINDOW_FOCUSED: {
    severity: 'WARN',
    strike: 'never',
    why: 'the student came back, which is the wanted outcome',
  },
  TAB_HIDDEN: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'thresholded, and correlated with blur so one alt-tab costs one count rather than two',
  },
  TAB_VISIBLE: { severity: 'WARN', strike: 'never', why: 'the student came back' },
  // A second LIVE session. `tabGuard` only emits this for a tab that answered, never for one that went quiet.
  MULTI_TAB_DETECTED: {
    severity: 'VIOLATION',
    strike: 'always',
    why: 'a second live attempt session',
  },
  COPY_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential, and only because copying is the easiest way to share it',
  },
  PASTE_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential; pasting is the easiest way to bring an answer in',
  },
  CONTEXT_MENU: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'the menu is how Save As is reached, so it counts with the print/save block rather than on its own',
  },
  PRINT_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential; print and Save As are the same disclosure',
  },
  SAVE_ATTEMPT: { severity: 'INFO', strike: 'never', why: 'advisory only' },
  // "advisory evidence only, never punitive" -- window size is not evidence of anything.
  DEVTOOLS_SIZE_ANOMALY: {
    severity: 'INFO',
    strike: 'never',
    why: 'advisory evidence only: a window size anomaly is not evidence of anything',
  },
  SAVE_REJECTED_LATE: {
    severity: 'INFO',
    strike: 'never',
    why: 'the server rejected the write; the client is reporting, not confessing',
  },
  QUESTION_WINDOW_CLOSED: {
    severity: 'INFO',
    strike: 'never',
    why: 'a consequence of a per-question timeout, which the policy chose',
  },
  CLOCK_SKEW_DETECTED: {
    severity: 'WARN',
    strike: 'never',
    why: 'advisory; the server enforces time',
  },
  NETWORK_LOST: { severity: 'INFO', strike: 'never', why: 'the network, not the student' },
  NETWORK_RESTORED: { severity: 'INFO', strike: 'never', why: 'the network, not the student' },
  AUTOSAVE_QUEUED: {
    severity: 'INFO',
    strike: 'never',
    why: 'explains a later gap in the timeline',
  },
  // "never penalises the student for our bug" -- `plans/09` §7.1.
  SIM_LOAD_FAILED: {
    severity: 'INFO',
    strike: 'never',
    why: "our bug, never the student's",
  },
  // INV-ACC-1.
  ACCOMMODATION_RELAXED: {
    severity: 'INFO',
    strike: 'never',
    why: 'INV-ACC-1: a relaxation is a right, never an offence',
  },
  // Server-emitted. Present so the server's rows are readable; the writer refuses to emit it.
  VIOLATION_THRESHOLD_REACHED: {
    severity: 'VIOLATION',
    strike: 'never',
    why: 'emitted by the SERVER, on evidence a human has not yet seen',
  },
  ATTEMPT_TERMINATED: { severity: 'INFO', strike: 'never', why: 'an outcome, not an offence' },
  ATTEMPT_SUBMITTED: { severity: 'INFO', strike: 'never', why: 'an outcome, not an offence' },
} as const);

/** The types the client must never emit. See the note at the top of this file. */
export const SERVER_ONLY_EVENTS: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'VIOLATION_THRESHOLD_REACHED',
]);

/** What the client knows about the policy, which is all the strike decision needs. */
export interface StrikePolicyView {
  readonly requireFullscreen: string;
  readonly requirePointerLock: string;
  readonly multiTabPolicy: string;
  readonly blockCopyPaste: boolean;
  readonly blockPrintSave: boolean;
}

/**
 * DOES THIS EVENT COUNT AS A STRIKE?
 *
 * The single place the answer is decided, for the four reasons in the note at the top of this file.
 */
export const countsAsStrike = (type: EvidenceType, policy: StrikePolicyView): boolean => {
  const rule = EVIDENCE_RULES[type];
  // A missing rule is a BUG, not a lenient default. Falling through to `false` here would silently un-strike a
  // violation the moment someone added an event type without a row.
  if (rule === undefined) throw new Error(`no evidence rule for ${String(type)}`);

  switch (rule.strike) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'when_fullscreen_required':
      return policy.requireFullscreen === 'WARN' || policy.requireFullscreen === 'BLOCK';
    case 'when_policy_says':
      // Each of these is policed only when the corresponding switch is on, so a copy-paste cannot enable one by
      // enabling another.
      if (type === 'POINTERLOCK_LOST') return policy.requirePointerLock !== 'OFF';
      if (type === 'COPY_ATTEMPT' || type === 'PASTE_ATTEMPT' || type === 'CONTEXT_MENU') {
        return policy.blockCopyPaste;
      }
      if (type === 'PRINT_ATTEMPT') return policy.blockPrintSave;
      // `WINDOW_BLURRED` and `TAB_HIDDEN` are thresholded rather than switched, and the threshold lives in
      // `thresholds`; whether the count has passed it is the ladder's decision, not this one's.
      return true;
    default:
      return false;
  }
};

export interface EvidenceRecord {
  readonly seq: number;
  readonly type: EvidenceType;
  readonly at: Millis;
  /** Free-form. Never an answer, never a score: this is read by a human. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * CANONICAL FORM, and it is canonical for a reason a reviewer will ask about.
 *
 * Keys are sorted so a signature computed on a phone matches one computed on a server, and `undefined` is dropped
 * rather than serialised, because `JSON.stringify` drops it anyway and two implementations that disagree about
 * whether a key exists produce two signatures for one batch.
 */
export const canonicalEvent = (event: EvidenceRecord): string => {
  const entries = Object.entries(event)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}:${JSON.stringify(value ?? null)}`);
  return `{${entries.join(',')}}`;
};

/** What gets signed: the attempt, the sequence range, and every event in order. */
export interface SignedBatch {
  readonly attemptId: string;
  readonly tabId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly events: readonly EvidenceRecord[];
  /** Hex HMAC over the canonical form, with domain separation. See `signBatch`'s caller for the key. */
  readonly signature: string;
}
/**
 * THE SIGNATURE INPUT.
 *
 * Returned separately from the signing so it can be tested on its own: the exact bytes that were signed are the thing a
 * dispute is about, and "the signature verified" is not evidence that the right thing was signed.
 *
 * `attemptId` and the sequence range are INSIDE the signed material, not merely alongside it. Without them a valid
 * signature could be replayed onto a different attempt or extended to cover events the signer never saw, and the whole
 * point of signing is that the server can tell a client's account from a client's invention.
 *
 * The `v1` tag is DOMAIN SEPARATION. The HMACs elsewhere in this repository all use `orrery.<purpose>.v1` with NUL
 * separators, and reusing a key across purposes without a tag lets a signature obtained for one thing be presented as a
 * signature for another.
 *
 * The separators are written as the ESCAPE `\u0000`, never as a literal byte: PF-4 records that a literal NUL in
 * source is a defect, because it is invisible in every diff and every editor.
 */
export const batchSigningInput = (input: {
  readonly attemptId: string;
  readonly tabId: string;
  readonly events: readonly EvidenceRecord[];
}): string => {
  const first = input.events[0]?.seq ?? 0;
  const last = input.events[input.events.length - 1]?.seq ?? 0;
  const body = input.events.map(canonicalEvent).join('\n');
  return [
    'orrery.evidence.v1',
    input.attemptId,
    input.tabId,
    String(first),
    String(last),
    body,
  ].join('\u0000');
};

/**
 * HOW EVENTS ARE DELIVERED. Injected: this module does not own transport, and P7's outbox owns answer saves, which are a
 * DIFFERENT pipeline with different loss guarantees.
 */
export type BatchTransport = (batch: Omit<SignedBatch, 'signature'>) => Promise<boolean>;

export interface BatcherOptions {
  /** Events per signature. Small enough that a lost batch loses little. */
  readonly batchSize: number;
  /**
   * The queue ceiling, and what happens at it is the important part.
   *
   * `plans/09` §7: "`sendBeacon` is fire-and-forget and may be lost: **telemetry may be incomplete, and that is
   * acceptable.**" So an overflowing queue DROPS the oldest telemetry and counts the loss, rather than growing without
   * bound during a three-hour exam or blocking the exam to preserve it.
   *
   * Answer SAVES are not in this queue and are never dropped here -- they are the outbox's job, and dropping a save
   * because telemetry filled up would be a catastrophic misplacement of priorities.
   */
  readonly maxQueued: number;
  readonly transport: BatchTransport;
}

export interface BatcherStats {
  readonly queued: number;
  readonly sent: number;
  /** Events dropped because the queue was full. Reported, never hidden: a timeline with holes should say so. */
  readonly dropped: number;
  readonly batchesFailed: number;
}

export class EvidenceBatcher {
  #queue: EvidenceRecord[] = [];
  #seq = 0;
  #dropped = 0;
  #sent = 0;
  #failed = 0;

  constructor(
    private readonly options: BatcherOptions,
    private readonly clock: { now(): number },
    private readonly attemptId: string,
    private readonly tabId: string,
    /** Injected so a test can sign deterministically; production passes an HMAC over `batchSigningInput`. */
    private readonly sign: (input: string) => string,
  ) {}

  /**
   * RECORD AN EVENT, OR REFUSE IT.
   *
   * Returns whether it was accepted. One refusal is possible and it is unconditional: a server-only type.
   */
  record(type: EvidenceType, detail?: EvidenceRecord['detail']): boolean {
    if (SERVER_ONLY_EVENTS.has(type)) {
      // A client that emitted its own escalation would be announcing a threshold breach on evidence a teacher has not
      // seen, and the ladder would act on the client's count.
      return false;
    }

    const event: EvidenceRecord = {
      seq: this.#seq,
      type,
      at: this.clock.now(),
      ...(detail === undefined ? {} : { detail }),
    };
    this.#seq += 1;

    if (this.#queue.length >= this.options.maxQueued) {
      // Drop the OLDEST, not the newest: a queue that sheds recent events loses the ones a teacher is currently looking
      // at, and the oldest are least likely to matter to the incident being reviewed.
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(event);
    return true;
  }

  /** Take up to `batchSize` events, leaving the rest queued. Returns an empty array when there is nothing to send. */
  takeBatch(): EvidenceRecord[] {
    return this.#queue.splice(0, this.options.batchSize);
  }

  /** Sign a batch without sending it, which is what the unload path needs. */
  signBatch(events: readonly EvidenceRecord[]): SignedBatch {
    const unsigned = {
      attemptId: this.attemptId,
      tabId: this.tabId,
      fromSeq: events[0]?.seq ?? 0,
      toSeq: events[events.length - 1]?.seq ?? 0,
      events,
    };
    return { ...unsigned, signature: this.sign(batchSigningInput(unsigned)) };
  }

  /**
   * SEND ONE BATCH. Returns whether it was accepted, and counts a failure rather than throwing.
   *
   * Telemetry is allowed to be lost, so a failed send is not an error the exam should surface. It is counted, and the
   * caller can surface the count in a diagnostic without interrupting a student.
   */
  async flushOnce(): Promise<boolean> {
    const events = this.takeBatch();
    if (events.length === 0) return true;
    const batch = this.signBatch(events);
    try {
      const ok = await this.options.transport({
        attemptId: batch.attemptId,
        tabId: batch.tabId,
        fromSeq: batch.fromSeq,
        toSeq: batch.toSeq,
        events: batch.events,
      });
      if (ok) this.#sent += events.length;
      else this.#failed += 1;
      return ok;
    } catch {
      this.#failed += 1;
      return false;
    }
  }

  /**
   * THE UNLOAD PATH, and it does NOT await.
   *
   * A `pagehide` handler that awaits has already lost the race: the document is going away. `plans/09` §7's position is
   * that telemetry may be lost, so this fires and returns.
   */
  flushOnUnload(): void {
    const events = this.takeBatch();
    if (events.length === 0) return;
    void this.options.transport({
      attemptId: this.attemptId,
      tabId: this.tabId,
      fromSeq: events[0]?.seq ?? 0,
      toSeq: events[events.length - 1]?.seq ?? 0,
      events,
    });
  }

  get stats(): BatcherStats {
    return {
      queued: this.#queue.length,
      sent: this.#sent,
      dropped: this.#dropped,
      batchesFailed: this.#failed,
    };
  }
}
