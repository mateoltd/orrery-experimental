/**
 * ICU-subset message compilation, with plural categories chosen by ICU rather than by `n === 1`.
 *
 * ## WHY A COMPILED SUBSET INSTEAD OF A DEPENDENCY
 *
 * The plural half is the only part of `P13-T7` with real logic in it, and the logic is small: parse
 * a message once, select an arm per call. `@formatjs/icu-messageformat-parser` would do the parse,
 * and would also add a runtime dependency to a package that currently has one (`@orrery/clock`) and
 * is imported by a Next.js edge route. The subset below is documented, strict, and rejects anything
 * it does not understand — which is the property a dependency would not give, because a library that
 * silently ignores `offset:` is worse than a parser that refuses the message.
 *
 * ## `n === 1 ? … : …` IS WRONG IN EVERY LANGUAGE THAT HAS MORE THAN TWO FORMS
 *
 * **ENGLISH HAS TWO PLURAL FORMS AND THAT IS AN ACCIDENT OF ENGLISH, NOT A PROPERTY OF COUNTING.**
 * Polish has four (`one`, `few`, `many`, `other`); Arabic has six (`zero`, `one`, `two`, `few`,
 * `many`, `other`); Russian has three. In Polish, 2 is `few` and 5 is `many`, so an English two-form
 * conditional renders "5 minutes" where Polish requires "5 minut" and "2 minutes" where it requires
 * "2 minuty". Nothing crashes and nothing looks broken — it is simply wrong in a language, to a
 * speaker of that language, on the one screen they are relying on.
 *
 * So the arm is chosen by `Intl.PluralRules(locale).select(n)`, which is ICU's own answer for the
 * locale, and which the tests pin against `pl` and `ar` rather than against English.
 *
 * ## THE TWO FAILURES ARE HANDLED DIFFERENTLY, ON PURPOSE
 *
 *   · **A MISSING KEY** degrades one string. It reports through the required `onIssue` callback and
 *     renders as the key itself, because a student mid-exam deserves a page that works and an
 *     operator deserves a report — not a crash.
 *   · **AN UNCOVERED PLURAL CATEGORY THROWS.** It is unreachable once `i18n:check` has passed, and
 *     reaching it means the catalogue is wrong in a way the gate forbids. Falling back to `other`
 *     there would print a sentence in the wrong grammatical number to someone who is already
 *     stressed, and would do so *quietly* — which is the whole failure this module exists to make
 *     impossible.
 *
 * ## SINGLE QUOTES ARE NOT AN ESCAPE CHARACTER HERE, DELIBERATELY
 *
 * ICU treats `'` as quoting. Half of this product's copy contains an apostrophe — `Couldn't save`,
 * `Someone else's` — and a subset that made `'` special would need a doubling rule to say so. It
 * does not, and a message containing `'` parses as itself. The cost is that ICU's `''` escape is
 * not available, and the parser rejects it rather than mis-reading it.
 */

import { localeFormatters, pluralCategories } from './intl.js';

/** Thrown for a message the parser does not understand. NEVER for a message that is merely absent. */
export class MessageSyntaxError extends Error {
  readonly pattern: string;
  readonly at: number;

  constructor(pattern: string, at: number, why: string) {
    // The pattern is quoted into the message because an ICU syntax error with no pattern shown is
    // the least actionable error message in the codebase.
    super(`i18n: malformed message at offset ${String(at)} (${why}): ${JSON.stringify(pattern)}`);
    this.name = 'MessageSyntaxError';
    this.pattern = pattern;
    this.at = at;
  }
}

/** Thrown when the locale selects a plural category the message does not cover. See the header. */
export class PluralCategoryGapError extends Error {
  readonly locale: string;
  /** The category ICU actually selected for this number. */
  readonly category: Intl.LDMLPluralRule;
  /** Every category the message does cover. `other` is excluded — it is the fallback, not a form. */
  readonly covered: readonly Intl.LDMLPluralRule[];
  /** Every category this locale can produce that the message has no arm for. */
  readonly missing: readonly Intl.LDMLPluralRule[];

  constructor(
    locale: string,
    category: Intl.LDMLPluralRule,
    covered: readonly Intl.LDMLPluralRule[],
    missing: readonly Intl.LDMLPluralRule[],
  ) {
    // All three lists are in the message. "it threw" is not actionable, "this locale needs `few` and
    // `many`" is, and a translator who has just been told which categories are missing does not have
    // to run the gate to find out.
    super(
      `i18n: locale ${locale} selects plural category ${JSON.stringify(category)} for a message ` +
        `that covers only ${covered.length === 0 ? '(no plural category)' : covered.join(', ')}. ` +
        `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
        'Falling back to `other` would render the wrong grammatical number, so this throws.',
    );
    this.name = 'PluralCategoryGapError';
    this.locale = locale;
    this.category = category;
    this.covered = covered;
    this.missing = missing;
  }
}

export type MessageArgValue = string | number | Date;
export type MessageArgs = Readonly<Record<string, MessageArgValue>>;

export type DateStyle = 'short' | 'medium' | 'long' | 'time';

export type NumberStyle = 'default' | 'percent';

/**
 * Date styles are PRESETS, not option bags, and each one takes its zone from the caller.
 *
 * A bare `{when, date}` with no `timeZone` renders in the HOST's zone, so the same message renders
 * differently on a CI server in `America/Chicago` and on a student's laptop in Cardiff, and the
 * difference is invisible until someone compares a screenshot to a support ticket. The zone is
 * therefore an explicit option rather than something a message can leave out.
 */
const DATE_STYLES: Readonly<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium', timeStyle: 'short' },
  long: { dateStyle: 'long', timeStyle: 'short' },
  time: { timeStyle: 'short' },
};

interface SelectorArm {
  /** `'zero'`, `'other'`, … or an exact selector written `=0`. */
  readonly selector: string;
  readonly nodes: readonly MessageNode[];
}

interface TextNode {
  readonly kind: 'text';
  readonly value: string;
}
interface ArgumentNode {
  readonly kind: 'argument';
  readonly name: string;
}
interface NumberNode {
  readonly kind: 'number';
  readonly name: string;
  readonly style: NumberStyle;
}
interface DateNode {
  readonly kind: 'date';
  readonly name: string;
  readonly style: DateStyle;
}
interface PluralNode {
  readonly kind: 'plural';
  readonly name: string;
  readonly arms: readonly SelectorArm[];
}
interface SelectNode {
  readonly kind: 'select';
  readonly name: string;
  readonly arms: readonly SelectorArm[];
}

export type MessageNode = TextNode | ArgumentNode | NumberNode | DateNode | PluralNode | SelectNode;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const DIGITS = /^[0-9]+/;

/** The ICU `#` sigil, which means "this plural's own number, in the locale's own format". */
const HASH = /#/g;

const CATEGORY_KEYWORDS: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

export function isCategoryKeyword(selector: string): boolean {
  return CATEGORY_KEYWORDS.includes(selector);
}

/**
 * Parse a pattern into a node list.
 *
 * Recursive descent over `(text | placeholder)*`, and every arm is parsed by the SAME function, so a
 * nested plural works and an unclosed brace inside an arm is still a syntax error. Re-entering with
 * a shared cursor would let an arm's `}` be mistaken for the outer message's, and a message that
 * renders wrong is a message nobody tests for shape.
 *
 * **STRICTNESS IS THE PROPERTY, NOT A LIMITATION.** Anything outside the documented subset — an
 * unclosed brace, a `plural` with no `other` arm, an unknown argument type, ICU literal tags,
 * `offset:` — throws. A permissive parser that ignores what it does not understand yields a message
 * that renders differently from what the catalogue says, and no test anywhere would notice.
 */
export function parseMessage(pattern: string): readonly MessageNode[] {
  let i = 0;

  // A `function` declaration rather than an arrow, because control-flow narrowing to `never` — which
  // is what lets `IDENT.exec(...)` be used without a null check at every use — only fires for a
  // declaration, and the cost of getting that wrong is four `possibly null` errors on a regex match.
  function fail(why: string): never {
    throw new MessageSyntaxError(pattern, i, why);
  }

  const readIdent = (): string => {
    const m = IDENT.exec(pattern.slice(i));
    if (!m) fail('expected an argument name');
    i += m[0].length;
    return m[0];
  };

  const skipSpace = (): void => {
    while (pattern[i] === ' ') i += 1;
  };

  /** Read a balanced `{ … }` and return its inner text. Used for `plural` and `select` arms. */
  const readBraced = (): string => {
    if (pattern[i] !== '{') fail("expected '{' to open an arm");
    const open = i;
    let depth = 0;
    for (; i < pattern.length; i += 1) {
      if (pattern[i] === '{') depth += 1;
      else if (pattern[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const inner = pattern.slice(open + 1, i);
          i += 1;
          return inner;
        }
      }
    }
    i = pattern.length;
    return fail("unclosed '{'");
  };

  const readArms = (): readonly SelectorArm[] => {
    const arms: SelectorArm[] = [];
    for (;;) {
      skipSpace();
      // The closing brace of the message the arms belong to. The arm's own `}` was already consumed
      // by `readBraced`, so this is unambiguous.
      if (i >= pattern.length || pattern[i] === '}') break;
      let selector: string;
      if (pattern[i] === '=') {
        i += 1;
        const m = DIGITS.exec(pattern.slice(i));
        if (!m) fail("expected digits after '=' in an exact selector");
        selector = `=${m[0]}`;
        i += m[0].length;
      } else {
        selector = readIdent();
      }
      skipSpace();
      arms.push({ selector, nodes: parseMessage(readBraced()) });
    }
    return arms;
  };

  const nodes: MessageNode[] = [];
  let text = '';
  const flush = (): void => {
    if (text.length > 0) {
      nodes.push({ kind: 'text', value: text });
      text = '';
    }
  };

  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '}') break;
    if (ch === '<') fail('ICU literal tags are not supported; a message renders plain text only');
    if (ch !== '{') {
      text += ch;
      i += 1;
      continue;
    }

    i += 1;
    const name = readIdent();
    skipSpace();
    if (pattern[i] === '}') {
      i += 1;
      flush();
      nodes.push({ kind: 'argument', name });
      continue;
    }
    if (pattern[i] !== ',') fail("expected ',' or '}' in a placeholder");
    i += 1;
    skipSpace();
    const type = readIdent();
    skipSpace();

    if (type === 'number') {
      let style: NumberStyle = 'default';
      if (pattern[i] === ',') {
        i += 1;
        skipSpace();
        const s = readIdent();
        if (s !== 'percent') fail(`unsupported number style ${JSON.stringify(s)}`);
        style = 'percent';
        skipSpace();
      }
      if (pattern[i] !== '}') fail("expected '}' after a number placeholder");
      i += 1;
      flush();
      nodes.push({ kind: 'number', name, style });
      continue;
    }

    if (type === 'date') {
      let style: DateStyle = 'medium';
      if (pattern[i] === ',') {
        i += 1;
        skipSpace();
        const s = readIdent();
        if (!(s in DATE_STYLES)) fail(`unsupported date style ${JSON.stringify(s)}`);
        style = s as DateStyle;
        skipSpace();
      }
      if (pattern[i] !== '}') fail("expected '}' after a date placeholder");
      i += 1;
      flush();
      nodes.push({ kind: 'date', name, style });
      continue;
    }

    if (type === 'plural' || type === 'select') {
      if (pattern[i] !== ',') fail(`expected ',' after \`{${name}, ${type}\``);
      i += 1;
      const arms = readArms();
      // `readArms` stops AT the placeholder's closing brace rather than eating it, so that the
      // `other`-arm check below can report a missing `other` with the cursor still on the arms.
      if (pattern[i] !== '}') fail(`unclosed \`{${name}, ${type}\``);
      i += 1;
      // ICU requires an `other` arm and this parser does not invent one, because an invented `other`
      // is a sentence in the wrong number for every locale with more than two forms.
      if (!arms.some((a) => a.selector === 'other')) {
        fail(`a ${type} needs an \`other\` arm — ICU requires one and this parser does not guess`);
      }
      flush();
      nodes.push(
        type === 'plural' ? { kind: 'plural', name, arms } : { kind: 'select', name, arms },
      );
      continue;
    }

    fail(`unsupported placeholder type ${JSON.stringify(type)}`);
  }

  flush();
  if (i < pattern.length) fail("unexpected '}'");
  return nodes;
}

/** Every argument name a message reads, nested arms included. */
export function placeholdersIn(
  nodes: readonly MessageNode[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        break;
      case 'argument':
      case 'number':
      case 'date':
        into.add(node.name);
        break;
      case 'plural':
      case 'select':
        into.add(node.name);
        placeholdersIn(
          node.arms.flatMap((arm) => arm.nodes),
          into,
        );
        break;
    }
  }
  return into;
}

/**
 * Does this message select a plural at all?
 *
 * **Needed because "covers no plural category" and "has no plural" are DIFFERENT STATES.** `'Saved'`
 * has no plural and needs no arm; `{n, plural, one {…} other {…}}` has a plural and is missing `few`
 * and `many`. A gate that cannot tell them apart flags every non-count string in the catalogue, and a
 * gate that flags every non-count string gets its plural findings ignored — which is how a real gap
 * ships.
 */
export function hasPlural(nodes: readonly MessageNode[]): boolean {
  return nodes.some((node) => {
    if (node.kind === 'plural') return true;
    if (node.kind === 'select') return node.arms.some((arm) => hasPlural(arm.nodes));
    return false;
  });
}

/**
 * The plural categories a pattern's `plural` selectors COVER.
 *
 * `=0` and `other` are excluded because neither is a plural category: `=0` is an exact match that
 * works in every locale, and `other` is the ICU fallback arm rather than a grammatical form. So a
 * message with only `=0` and `other` legitimately covers nothing, and `i18n:check` says so instead
 * of counting the fallback as coverage — which is how a two-form message would pass for Polish.
 */
export function categoriesCovered(pattern: string): ReadonlySet<Intl.LDMLPluralRule> {
  const covered = new Set<Intl.LDMLPluralRule>();
  const walk = (nodes: readonly MessageNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'plural') {
        for (const arm of node.arms) {
          if (arm.selector.startsWith('=') || arm.selector === 'other') continue;
          covered.add(arm.selector as Intl.LDMLPluralRule);
        }
        walk(node.arms.flatMap((arm) => arm.nodes));
      } else if (node.kind === 'select') {
        walk(node.arms.flatMap((arm) => arm.nodes));
      }
    }
  };
  walk(parseMessage(pattern));
  return covered;
}

/**
 * The formatters a render needs, derived from the locale ONCE per render.
 *
 * Bundled rather than passed as four separate arguments because a caller that supplies the plural
 * rules separately from the number formatter is a caller who will eventually mismatch them — which is
 * how a Polish plural rule ends up selecting an arm beside an English-formatted number.
 */
export interface RenderLocale {
  readonly tag: string;
  readonly timeZone: string;
  readonly select: (n: number) => Intl.LDMLPluralRule;
  /**
   * Every category this locale can produce, asked of ICU.
   *
   * Carried on the render rather than looked up inside the throw, because the throw has to say which
   * categories the message is MISSING — and answering that from `Intl.PluralRules` a second time at
   * the moment of failure is a second place for the two answers to disagree.
   */
  readonly categories: readonly Intl.LDMLPluralRule[];
  readonly number: (n: number) => string;
  readonly percent: (n: number) => string;
  readonly date: (instant: Date, style: DateStyle) => string;
}

export function renderLocaleFor(locale: string, timeZone: string): RenderLocale {
  const formatters = localeFormatters(locale);
  return {
    tag: locale,
    timeZone,
    select: (n) => formatters.pluralRules().select(n),
    categories: pluralCategories(locale),
    number: (n) => formatters.number().format(n),
    percent: (n) => formatters.number({ style: 'percent' }).format(n),
    date: (instant, style) =>
      formatters.dateTime({ ...DATE_STYLES[style], timeZone }).format(instant),
  };
}

/**
 * What a render reports when it cannot do the right thing with what it was given.
 *
 * A STRUCTURED kind rather than a message string, because `createTranslator` has to turn this into a
 * `MessageIssue` carrying the key and the locale, and recovering a class of problem by matching the
 * words in an English sentence is a way to lose the class the moment someone rewords it.
 */
export type RenderIssueKind = 'missing-argument' | 'bad-argument' | 'no-select-arm';

export interface RenderIssue {
  readonly kind: RenderIssueKind;
  readonly detail: string;
}

export type IssueReporter = (issue: RenderIssue) => void;

const compiled = new Map<string, readonly MessageNode[]>();

/**
 * Compile, memoised on the pattern.
 *
 * The cache is safe to keep because its key set is bounded by the catalogue: `createTranslator`
 * only accepts keys from a closed union, so there is no unbounded input. `formatMessage` is the one
 * entry point that takes a free-form pattern, and it is only reached from tests and from `./index.ts`
 * holding its own pattern — so the cache grows by the size of the catalogue and no further.
 */
export function compile(pattern: string): readonly MessageNode[] {
  const hit = compiled.get(pattern);
  if (hit !== undefined) return hit;
  const nodes = parseMessage(pattern);
  compiled.set(pattern, nodes);
  return nodes;
}

/** How many patterns are compiled. Exported so a test can prove the memo actually memoises. */
export function compiledCount(): number {
  return compiled.size;
}

function render(
  nodes: readonly MessageNode[],
  ctx: RenderLocale,
  args: MessageArgs,
  onIssue: IssueReporter,
  /** The `#` substitution, defined only inside a `plural` arm — ICU has no `#` elsewhere. */
  hash: string | null,
): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += hash === null ? node.value : node.value.replace(HASH, hash);
        break;
      case 'argument': {
        const value = args[node.name];
        if (value === undefined) {
          onIssue({ kind: 'missing-argument', detail: `\`{${node.name}}\` has no argument` });
          out += `{${node.name}}`;
          break;
        }
        out += String(value);
        break;
      }
      case 'number': {
        const value = args[node.name];
        // `undefined` and a wrong type are DIFFERENT bugs and get different kinds: the first is a
        // caller who forgot an argument, the second is a caller who passed the wrong one.
        if (typeof value !== 'number') {
          onIssue({
            kind: value === undefined ? 'missing-argument' : 'bad-argument',
            detail: `\`{${node.name}, number}\` needs a number, got ${typeof value}`,
          });
          out += `{${node.name}}`;
          break;
        }
        out += node.style === 'percent' ? ctx.percent(value) : ctx.number(value);
        break;
      }
      case 'date': {
        const value = args[node.name];
        if (!(value instanceof Date)) {
          onIssue({
            kind: value === undefined ? 'missing-argument' : 'bad-argument',
            detail: `\`{${node.name}, date}\` needs a Date, got ${typeof value}`,
          });
          out += `{${node.name}}`;
          break;
        }
        out += ctx.date(value, node.style);
        break;
      }
      case 'select': {
        const value = args[node.name];
        const tag = value === undefined ? 'other' : String(value);
        const arm = node.arms.find((a) => a.selector === tag);
        if (arm === undefined) {
          // Falling through to `other` silently here would be the same defect as the plural gap:
          // a sentence in a form nobody chose, that reads as though it were the right one.
          onIssue({ kind: 'no-select-arm', detail: `no arm for select ${JSON.stringify(tag)}` });
          out += `{${node.name}}`;
          break;
        }
        out += render(arm.nodes, ctx, args, onIssue, null);
        break;
      }
      case 'plural': {
        const value = args[node.name];
        if (typeof value !== 'number') {
          onIssue({
            kind: value === undefined ? 'missing-argument' : 'bad-argument',
            detail: `\`{${node.name}, plural}\` needs a number, got ${typeof value}`,
          });
          out += `{${node.name}}`;
          break;
        }
        const exact = node.arms.find((a) => a.selector === `=${String(value)}`);
        if (exact !== undefined) {
          out += render(exact.nodes, ctx, args, onIssue, ctx.number(value));
          break;
        }
        const category = ctx.select(value);
        const arm = node.arms.find((a) => a.selector === category);
        if (arm !== undefined) {
          out += render(arm.nodes, ctx, args, onIssue, ctx.number(value));
          break;
        }
        // THE BRANCH THIS FILE EXISTS FOR. ICU would fall through to `other` here. Falling through
        // to `other` silently is how a two-form message ends up serving a four-form language, so it
        // throws and names the categories the message does have.
        const covered = node.arms
          .filter((a) => isCategoryKeyword(a.selector) && a.selector !== 'other')
          .map((a) => a.selector as Intl.LDMLPluralRule);
        throw new PluralCategoryGapError(
          ctx.tag,
          category,
          covered,
          ctx.categories.filter((c) => c !== 'other' && !covered.includes(c)),
        );
      }
    }
  }
  return out;
}

export interface FormatOptions {
  readonly locale: string;
  /** Required. A message with no `timeZone` renders in the HOST's zone, and that is not acceptable. */
  readonly timeZone: string;
}

/**
 * Render a pattern with NO catalogue lookup at all.
 *
 * The keyless path, used by `./index.ts` for the messages it holds patterns for directly. Because
 * there is no lookup there is no `missing-key` case, so `onIssue` reports only argument mistakes.
 */
export function formatMessage(
  pattern: string,
  args: MessageArgs,
  options: FormatOptions,
  onIssue?: IssueReporter,
): string {
  return render(
    compile(pattern),
    renderLocaleFor(options.locale, options.timeZone),
    args,
    onIssue ?? (() => undefined),
    null,
  );
}
