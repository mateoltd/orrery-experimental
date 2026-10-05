/**
 * The bounded, sanitised trace a simulation replay shows a marker.  (P9-T7)
 *
 * ## WHY THIS FILE EXISTS AT ALL, WHEN `JSON.stringify(trace)` WOULD DO
 *
 * Three separate hazards, and they are separate because they have separate fixes:
 *
 *  1. **It is third-party output of unbounded size.** A sim bundle is code we did not write, and the trace it appends
 *     to is whatever it chose to append (`plans/10` §2.2: `sim:telemetry`, "allowlisted metrics; no PII, no free
 *     text"). A `PATH_SENSITIVE` grader reading a trace is a grader reading a document whose length the marker did not
 *     choose, and `plans/07` §3.4 requires `stateSchema` to be bounded for the same reason.
 *  2. **It lands in a DOM and in a marker's eyes.** A trace entry rendered as text is still text: an ANSI escape
 *     renders as an action in some terminals, and a control character in a `<code>` block is a page a marker has to
 *     read past.
 *  3. **It contains the student's answer.** `AnswerReplay` hands it to a marker who is deciding whether to override a
 *     mark, so the sanitiser's job is to make the text SAFE TO SHOW, not to decide what it may contain. What it must
 *     never do is quietly shorten it without saying so -- a marker overriding a mark on the strength of a trace that
 *     stops at entry 50 of 900 has been shown a fiction.
 *
 * ## SO EVERY CUT IS COUNTED, NEVER SILENT
 *
 * `boundTrace` returns `entries`, `omittedEntries`, `truncatedEntries` and `bytes`. The UI must render all four, and
 * `grading-replay-trace.test.ts` holds the rendered copy in `AnswerReplay.tsx` to it. `copy.ts:245` already promises the
 * stored replay "does not re-run the grader, and it does not change the mark"; nothing in this file weakens that, and
 * the replay that re-runs is named separately so a marker can never mistake one for the other.
 */

/**
 * THE CEILINGS, and why each number is where it is.
 *
 * `maxEntries` bounds the RENDER: a marker scrolls a list, and 900 rows is a scroll nobody reads, which is the same as
 * showing nothing while claiming to show everything.
 *
 * `maxCharsPerEntry` bounds one row's width: a single entry can be a whole JSON object, and a 200 kB row in a
 * `<pre>` either wraps into a wall or is truncated by the browser with no record that it was.
 *
 * `maxTotalChars` is the one that matters for availability, and it is a TOTAL rather than a product of the other two
 * because a bundle can emit 200 entries of 200 kB each and the product is the number that has to hold. It is also the
 * bound on what can be logged: a replay handler that returns this object cannot produce a log line larger than it.
 *
 * The floor of 1 on each is not decoration: a limit of zero makes `boundTrace` return nothing for every trace, which is
 * indistinguishable from a simulation that produced no interaction at all.
 *
 * **AND A TOTAL SMALLER THAN ONE ENTRY YIELDS NOTHING, WHICH IS WHY THE DEFAULTS ARE ORDERED THE WAY THEY ARE.**
 * `maxTotalChars` is 40,000 against a `maxCharsPerEntry` of 2,000 -- an order of magnitude of headroom -- so no default
 * configuration can produce an empty trace from a non-empty one. A caller who sets a total below one entry gets an empty
 * result with `complete: false`, which the UI renders as unreadable rather than as "the student did nothing". The
 * alternative -- always emitting at least one entry -- would break the `bytes <= maxTotalChars` guarantee, and THAT
 * guarantee is the one the resource bound rests on.
 */
export interface TraceLimits {
  readonly maxEntries: number;
  readonly maxCharsPerEntry: number;
  readonly maxTotalChars: number;
}

export const TRACE_LIMITS: TraceLimits = {
  maxEntries: 200,
  maxCharsPerEntry: 2_000,
  maxTotalChars: 40_000,
};

export interface BoundedTrace {
  readonly entries: readonly string[];
  /** Entries the trace had that are not in `entries`, because the entry or total ceiling was reached. */
  readonly omittedEntries: number;
  /** Of the entries shown, how many were shortened at `maxCharsPerEntry`. */
  readonly truncatedEntries: number;
  /** Characters in `entries`, which is also the bound on any log line derived from this. */
  readonly bytes: number;
  /** False when nothing was cut. A caller rendering a trace MUST show the difference when it is true. */
  readonly complete: boolean;
}

/**
 * WHAT ONE ENTRY BECOMES, and it must not be able to throw.
 *
 * `JSON.stringify` was the first version and it fails three ways on data a sim wrote: a `BigInt` throws, a cycle
 * throws, and a getter that throws is invoked. `simulation.ts:148-169`'s `show` already refuses to call `toString` on
 * a bundle's object for the same reason ("an object's `toString` is the bundle's code"), and this walks into objects
 * where that one deliberately did not -- but it walks them with the rule that a value it cannot read is NAMED rather
 * than printed.
 *
 * `depth` and `seen` are the cycle bound: an object reached twice on one path is printed as `[circular]`, and a path
 * deeper than `MAX_DEPTH` as `[deep]`. A trace is a log, and a log that can recurse until the stack runs out is an
 * unhandled rejection on an exam server.
 */
const MAX_DEPTH = 6;

/**
 * DEL IS REPLACED, AND IT IS THE ONLY CONTROL CHARACTER LEFT TO REPLACE.
 *
 * A trace entry is shown in a `<code>` block and may reach a terminal through a copied selection, and an ESC is a control
 * SEQUENCE rather than a character -- so a sim that emits one is writing to the screen a marker is looking at. That reads
 * like an argument for a whole C0 range, and the first version of this function was exactly that.
 *
 * **IT WAS A REGEX OVER ALREADY-ESCAPED TEXT, AND IT COULD MATCH NOTHING.** `renderValue` reaches strings through
 * `JSON.stringify`, and `JSON.stringify` escapes every character in `\u0000`-`\u001F` as a literal `\uXXXX` sequence, so a
 * NUL or an ESC in a value is never present in the rendered string as a control character. A range covering them was
 * untestable code carrying a hazard-shaped comment, which is worse than no code: it read as a guarantee. Verified:
 * `JSON.stringify('\u0000')` is `"\\u0000"` and `JSON.stringify('\u001b')` is `"\\u001b"`.
 *
 * DEL (`\u007F`) is the one character in that neighbourhood JSON does NOT escape, which makes it the only one a regex can
 * do anything about on this text. Written as an escape rather than a literal byte, because this repository has already had
 * an incident with a control character in source making a file binary (`evidence-wire.test.ts:161-163`). ESLint and Biome
 * both forbid this pattern and their suppressions have to sit in DIFFERENT places, which
 * `evidence-wire.test.ts:164-176` explains in full.
 */
/**
 * NO LINTER SUPPRESSION IS NEEDED FOR THIS, AND THE FIRST TWO VERSIONS CARRIED ONE THAT DID NOTHING.
 *
 * The pattern is `/[\u007F]/g` and BOTH linters accept it: `lint/suspicious/noControlCharactersInRegex` does not fire,
 * and neither does `no-control-regex`. Both were suppressed anyway -- the Biome one on the line above and an
 * `eslint-disable-line` trailing it -- and `pnpm lint` reported both as `suppressions/unused` and
 * "Unused eslint-disable directive".
 *
 * That is worth more than tidiness. `evidence-wire.test.ts:170-176` documents the whole C0 range needing suppressions, so
 * the reflex is to write them for any control-character regex; here that reflex produced two directives that suppressed
 * nothing while LOOKING like the guarantee they were meant to be. The earlier version of this function genuinely did need
 * one -- it matched a C0 range -- and that is why it is quoted above rather than deleted.
 */
const stripControls = (text: string): string => text.replace(/\u007F/g, '\uFFFD');

const renderValue = (value: unknown, depth: number, seen: readonly unknown[]): string => {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      /**
       * `NaN` AND THE INFINITIES ARE PRINTED AS THEMSELVES, NOT AS `null`.
       *
       * `JSON.stringify(NaN)` is `null`, and `simulation.ts:172-179` names the harm precisely: "it prints `NaN` as
       * `null` -- so the one detail a marker was given about an unreadable score named a value the grader had NOT
       * returned". A marker reading `null` in a trace concludes the grader computed nothing; reading `NaN` concludes the
       * grader computed something it should not have. The second is the true statement and the first is a lie that
       * happens to look tidy.
       */
      return String(value);
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${String(value)}n`;
    case 'undefined':
      return 'undefined';
    case 'function':
      return '"[function]"';
    case 'symbol':
      // `String(symbol)` THROWS: a symbol has no primitive string form, and `simulation.ts:148`'s `show` reaches
      // `String(value)` on its `default` arm -- this is the one value that would have thrown there.
      return '"[symbol]"';
    default:
      break;
  }
  if (value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '"[deep]"';
  /**
   * THE PLACEHOLDERS ARE QUOTED, because they stand in for a value rather than for structure.
   *
   * `"[circular]"` inside an object reads as a string that could have been in the trace; `[circular]` reads as a nested
   * array, which is the one reading that would make a marker go looking for two entries where there is one. Same reason
   * `"[deep]"`, `"[function]"`, `"[symbol]"` and `"[unreadable entry]"` are quoted in a value position.
   *
   * And the cycle check is an IDENTITY check rather than a `toString`, because this walks into objects
   * `simulation.ts:164-165` deliberately refuses to: a bundle's object with a `toString` is the bundle's code, and
   * calling it to detect a cycle would be running it.
   */
  if (seen.some((held) => held === value)) return '"[circular]"';
  if (Array.isArray(value)) {
    const next = [...seen, value];
    return `[${value.map((item) => renderValue(item, depth + 1, next)).join(',')}]`;
  }
  const next = [...seen, value];
  /**
   * KEYS ARE SORTED, so two replays of the same answer render the same line.
   *
   * A trace came out of `jsonb`, which does not preserve key order, so insertion order would make two replays of an
   * unchanged answer print different text -- and a marker comparing two traces of the same stored answer is exactly the
   * comparison this feature invites. `evidence.ts`'s `canonicalJson` sorts for the signing reason; the UI reason is the
   * same defect wearing different clothes. The test asserts it rather than trusting it.
   */
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, inner]) => `${JSON.stringify(key)}:${renderValue(inner, depth + 1, next)}`);
  return `{${entries.join(',')}}`;
};

/**
 * ONE ENTRY AS ONE LINE, and it cannot throw whatever the bundle put in the array.
 *
 * Total by construction, like `simulation.ts`'s `describeThrown`: a `try` that fails cannot answer "here is the entry",
 * and the caller is a screen that must show something. The catch names the failure rather than hiding it, because a
 * marker who cannot see entry 40 needs to know the platform could not read it and not that there was nothing there.
 */
export const describeTraceEntry = (entry: unknown): string => {
  try {
    return stripControls(renderValue(entry, 0, []));
  } catch {
    return '"[unreadable entry]"';
  }
};

const clampLimit = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;

/**
 * CUT A STORED TRACE TO WHAT MAY BE SHOWN, AND SAY WHAT WAS CUT.
 *
 * Entries are cut from the END, because a trace is chronological and a marker reads it forwards: the first thing the
 * student did is the first thing worth reading, and the tail of a long session is where a marker stops looking. Cutting
 * from the front to preserve the tail would be defensible for a different question and would be wrong here.
 *
 * The total is enforced AFTER the per-entry cut, so `bytes` never exceeds `maxTotalChars` even when the per-entry
 * allowance would have permitted it. That ordering is the availability guarantee: the number is the bound on the
 * payload, not on the input.
 */
export const boundTrace = (trace: unknown, limits: TraceLimits = TRACE_LIMITS): BoundedTrace => {
  const maxEntries = clampLimit(limits.maxEntries, TRACE_LIMITS.maxEntries);
  const maxCharsPerEntry = clampLimit(limits.maxCharsPerEntry, TRACE_LIMITS.maxCharsPerEntry);
  const maxTotalChars = clampLimit(limits.maxTotalChars, TRACE_LIMITS.maxTotalChars);
  /**
   * NOT AN ARRAY IS NOT AN EMPTY TRACE. A replay whose stored trace is an object, a string or absent is showing a
   * platform defect, and reporting "no entries" would put a clean sentence on screen where the truth is that we could
   * not read what was stored -- which is the `INV-SIM-2` shape (`copy.ts:35`: "a fault in the platform, not in the work").
   */
  if (!Array.isArray(trace)) {
    return { entries: [], omittedEntries: 0, truncatedEntries: 0, bytes: 0, complete: false };
  }

  const entries: string[] = [];
  let truncatedEntries = 0;
  let bytes = 0;
  for (const raw of trace) {
    if (entries.length >= maxEntries) break;
    let text = describeTraceEntry(raw);
    if (text.length > maxCharsPerEntry) {
      text = `${text.slice(0, maxCharsPerEntry)}…`;
      truncatedEntries += 1;
    }
    if (bytes + text.length > maxTotalChars) break;
    entries.push(text);
    bytes += text.length;
  }
  const omittedEntries = Math.max(0, trace.length - entries.length);
  return {
    entries,
    omittedEntries,
    truncatedEntries,
    bytes,
    complete: omittedEntries === 0 && truncatedEntries === 0,
  };
};
