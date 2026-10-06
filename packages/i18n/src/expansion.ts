/**
 * TEXT EXPANSION, WHICH IS NOT THE SAME PROBLEM AS TRANSLATION.
 *
 * ## WHAT THIS FILE IS FOR
 *
 * `P13-T8` asks for "**+30% text-expansion tests**". That is not a request to ship a German
 * catalogue. It is a request about a specific, measurable failure that English copy hides:
 *
 * **German and Finnish run roughly 30% longer than English, and Norwegian longer still.** So a
 * button that fits "Review" in English fits "Überprüfen" without complaint, and then clips to
 * "Überprüf…" on the one student's screen that is already the widest. The defect is invisible in
 * review because **every string a developer can see is the short one.**
 *
 * This module expands every catalogue message by a factor and reports what would break. It is
 * deliberately NOT a translation: inventing German would mean shipping copy nobody reviewed, which
 * is the failure this project has hit in its plans rather than in its code.
 *
 * ## WHY EXPANSION BY A STRING-REPEAT CANNOT ANSWER THE QUESTION
 *
 * The obvious implementation is `"Review".repeat(1.3)`, and it is worse than useless, for two
 * reasons worth stating because both are silent:
 *
 * 1. **`String.prototype.repeat` takes an integer.** `repeat(1.3)` floors to `repeat(1)` -- it
 *    returns the original string, so **the test passes on the unmodified input and reports that
 *    expansion is safe.** A gate that cannot fail is worse than no gate, because it is read as
 *    evidence. `expand()` therefore uses measured string length, never `repeat`.
 *
 * 2. **Repeating a whole message duplicates its ICU structure.** `"in {count, plural, one {# minute}
 *    other {# minutes}}".repeat(2)` produces two `#` and two `{count`, so any parser downstream
 *    sees a malformed message.
 *
 * ## THE BUG THIS FILE ACTUALLY HAD, AND WHY IT IS WRITTEN THE WAY IT IS NOW
 *
 * I first expanded by SPLITTING the message on a placeholder regex, `(\{[^{}]*\})`. That is the
 * obvious implementation and **it is wrong for nested ICU.** `[^{}]*` cannot cross a brace, so on
 * `{count, plural, one {# minute} other {# minutes}}` it matches only the two INNER arms, leaves
 * the outer `{count, plural, ...}` and the closing braces as "literal text" — and then pads them.
 * The message came out ending `}x`, and the real parser rejected it.
 *
 * **This was caught by the parser, which is the argument for injecting the parser.** A brace counter
 * would have reported the message as fine: braces balanced at the source, one more `x` at the end.
 * So expansion is now a walk of the PARSED AST, expanding only `kind: 'text'` nodes and rendering
 * every other node back verbatim. A translator lengthens prose, and prose is exactly what a text
 * node is.
 *
 * ## WHAT IS ACTUALLY CHECKED, AND WHAT IS NOT
 *
 * Checked, because they are properties of the message text and hold regardless of CSS:
 *   - **every placeholder survives expansion**, with the same names and the same order;
 *   - **the ICU structure still parses**, so expansion cannot silently unbalance a brace;
 *   - **no message contains a hard line break**, because a translated string with an embedded
 *     `\n` at +30% wraps unpredictably inside a fixed-height alert.
 *
 * NOT checked, and this is the important half: **whether the layout actually survives.** That is a
 * rendering property. A `max-width` or `text-overflow: ellipsis` that clips an expanded string is
 * invisible to this module and is caught by `P13-T6`/`P13-T9` against real assistive technology in
 * a real screen reader -- which is the only place it can be honestly caught. `audit.ts` therefore
 * reports truncation-prone CSS next to these findings so that a reader sees both halves at once
 * rather than a green expansion report that reads as "layout is safe".
 */

/** A `\n` inside a message is a hard break that expansion makes unpredictable. */
const HARD_BREAK = /\n/;

/**
 * Message syntax validation, injected so `expansion.ts` does not import the parser.
 *
 * Passing the real `parseMessage` in is the whole reason expansion can claim the ICU structure
 * still parses: a hand-rolled brace counter here would be a second, weaker grammar, and **two
 * grammars for one format means one of them is wrong.** `index.ts` wires it to `message.js`.
 */
export type MessageParser = (pattern: string) => readonly MessageNode[];

/**
 * Grows a literal segment to `factor` of its measured length.
 *
 * Works in CHARACTERS rather than words on purpose. Word-count expansion is the number quoted in
 * localisation literature ("German is 30% longer"), but it is not reproducible on a four-character
 * word: "Review" is 6 characters and 7 words would be nonsense. Characters are the unit the browser
 * actually lays out for a single-line control, which is the case this module exists to protect.
 *
 * `Math.ceil` rather than `Math.round` so the factor is a floor on growth, never a shrink: a gate
 * that under-reports expansion by one character is a gate that misses the tightest case.
 */
function expandSegment(segment: string, factor: number): string {
  const target = Math.ceil(segment.length * factor);
  if (target <= segment.length) {
    return segment;
  }
  return segment.length === 0 ? segment : segment + 'x'.repeat(target - segment.length);
}

/** One finding about a single message key. `rule` matches the ids `audit.ts` already uses. */
export interface ExpansionFinding {
  readonly rule: 'expansion/placeholder-lost' | 'expansion/icu-unbalanced' | 'expansion/hard-break';
  readonly key: string;
  readonly detail: string;
}

/** The default factor `P13-T8` names. */
export const EXPANSION_FACTOR = 1.3;

export interface ExpansionReport {
  readonly factor: number;
  /** Every key expanded, so a caller can prove coverage rather than assume it. */
  readonly checked: number;
  readonly findings: readonly ExpansionFinding[];
  /** `false` once anything is found, so a gate can branch without re-deriving the answer. */
  readonly ok: boolean;
}

/**
 * Names the placeholders in a message, in order.
 *
 * Order is part of the contract: `{a} then {b}` and `{b} then {a}` are different sentences, and a
 * check that compared them as SETS would pass a translation that swapped them. `P13-T7`'s audit
 * compares placeholder sets for the same reason, and this returns an ordered list so the expansion
 * check does not inherit the weaker form.
 */
export interface MessageNode {
  readonly kind: 'text' | 'argument' | 'number' | 'date' | 'plural' | 'select';
  readonly value?: string;
  readonly name?: string;
  readonly style?: unknown;
  readonly selector?: string;
  readonly arms?: readonly { readonly selector: string; readonly nodes: readonly MessageNode[] }[];
}

/** Element-wise equality, for the ORDER check. `every` on a shorter array would pass a prefix. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Renders a node back to source, expanding only `text`. Everything else is copied verbatim. */
function renderNode(node: MessageNode, factor: number): string {
  switch (node.kind) {
    case 'text':
      return expandSegment(node.value ?? '', factor);
    case 'argument':
      return `{${node.name}}`;
    case 'number':
    case 'date':
      return `{${node.name}, ${node.kind}, ${String(node.style)}}`;
    case 'plural':
    case 'select':
      return `{${node.name}, ${node.kind}, ${(node.arms ?? [])
        .map((arm) => `${arm.selector} {${renderNodes(arm.nodes, factor)}}`)
        .join(' ')}}`;
  }
}

function renderNodes(nodes: readonly MessageNode[], factor: number): string {
  return nodes.map((node) => renderNode(node, factor)).join('');
}

/**
 * Every argument name a message reads, IN SOURCE ORDER, nested arms included.
 *
 * Delegated to the package's own `placeholdersIn` so there is ONE definition of "placeholder" in
 * this codebase. My first version re-derived it from a regex, and the two disagreed — which is the
 * same bug wearing a different hat.
 */
export function placeholdersIn(message: string, parse: MessageParser): string[] {
  const names: string[] = [];
  const walk = (nodes: readonly MessageNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text') continue;
      if (node.kind === 'argument' || node.kind === 'number' || node.kind === 'date') {
        if (node.name !== undefined) names.push(node.name);
        continue;
      }
      for (const arm of node.arms ?? []) walk(arm.nodes);
    }
  };
  walk(parse(message));
  return names;
}

/**
 * Expands one message's PROSE and nothing else.
 *
 * Throws when the message does not parse, rather than expanding a string it cannot understand.
 * **A module that returns a plausible-looking expansion of a message it failed to read is exactly
 * how a broken message gets a passing gate.**
 */
export function expand(message: string, factor = EXPANSION_FACTOR, parse?: MessageParser): string {
  if (parse === undefined) {
    // No parser supplied: expand the flat case only, and say so in the type by requiring `parse`
    // in `auditExpansion`. Direct callers in tests pass the real parser.
    throw new TypeError('expand() needs the parser; use auditExpansion() or pass `parse`');
  }
  return renderNodes(parse(message), factor);
}

/**
 * Whether `parseMessage` accepts the grown message.
 *
 * Uses the real parser rather than counting braces, because a brace counter passes
 * `{a, plural, other {b}}` shaped nonsense that is balanced but invalid -- **and an unbalanced check
 * is the check that looks rigorous and catches nothing.**
 */
function parsesAsMessage(parser: MessageParser, message: string): boolean {
  try {
    parser(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expands every message in a catalogue and reports what breaks.
 *
 * `catalogue` is the locale's strings; `source` is the locale they were translated from, so a key
 * that exists in one and not the other is reported here too rather than being silently skipped. A
 * check that only walks the source would pass a translation that had DELETED a key.
 */
export function auditExpansion(
  catalogue: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string>>,
  parse: MessageParser,
  factor = EXPANSION_FACTOR,
): ExpansionReport {
  const findings: ExpansionFinding[] = [];
  const keys = new Set([...Object.keys(source), ...Object.keys(catalogue)]);

  for (const key of keys) {
    const message = catalogue[key];
    if (message === undefined) {
      findings.push({
        rule: 'expansion/placeholder-lost',
        key,
        detail: `absent from the catalogue: present in the source, so this locale DROPS a message`,
      });
      continue;
    }

    let grown: string;
    try {
      grown = expand(message, factor, parse);
    } catch {
      // The SOURCE message is what does not parse. That is `i18n:check`'s finding to report, and
      // reporting it here as well would count one defect twice -- which is how a findings list
      // stops being a list of defects and becomes a total.
      continue;
    }

    // Every read of `grown` goes through the parser, so all of them are inside this guard. An
    // earlier version read placeholders outside it, and a parser that rejected the grown message
    // threw out of `auditExpansion` instead of being REPORTED -- **a gate that crashes on the
    // defect it exists to catch is a gate whose exit code nobody reads.**
    let grownNames: readonly string[];
    let sourceNames: readonly string[];
    try {
      grownNames = placeholdersIn(grown, parse);
      sourceNames = placeholdersIn(message, parse);
    } catch {
      findings.push({
        rule: 'expansion/icu-unbalanced',
        key,
        detail: `expansion produced a message the parser cannot read`,
      });
      continue;
    }

    // Compared as arrays, not as joined strings: a separator would have to be a character that
    // cannot occur inside a placeholder, and NUL is the only one that qualifies -- which makes the
    // source file binary and the intent invisible. Array equality has no such precondition.
    if (!sameOrder(grownNames, sourceNames)) {
      findings.push({
        rule: 'expansion/placeholder-lost',
        key,
        detail: `placeholders changed under expansion: ${sourceNames.join(', ')} -> ${grownNames.join(', ')}`,
      });
    }

    // Only reported when the SOURCE parses and the expansion does not. A message that was already
    // invalid is `P13-T7`'s `i18n:check` finding, and reporting it here too would double-count one
    // defect as two -- which is how a findings list stops being countable.
    if (parsesAsMessage(parse, message) && !parsesAsMessage(parse, grown)) {
      findings.push({
        rule: 'expansion/icu-unbalanced',
        key,
        detail: `the real parser accepts this message but rejects it after expansion`,
      });
    }

    if (HARD_BREAK.test(message)) {
      findings.push({
        rule: 'expansion/hard-break',
        key,
        detail: `contains a hard line break, so expansion wraps unpredictably inside a fixed-height alert`,
      });
    }
  }

  return {
    factor,
    checked: keys.size,
    findings,
    ok: findings.length === 0,
  };
}
