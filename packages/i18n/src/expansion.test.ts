import { describe, expect, it } from 'vitest';
import { auditExpansion, EXPANSION_FACTOR, expand, placeholdersIn } from './expansion.js';
import type { MessageNode } from './message.js';
import { parseMessage } from './message.js';

/** The REAL parser, so these tests exercise the same grammar the package ships. */
const parse = parseMessage;

describe('EXPANSION GROWS THE TEXT, WHICH IS THE WHOLE POINT', () => {
  it('makes a short English string LONGER, which is what German and Finnish do to it', () => {
    expect(expand('Review', 1.3, parse).length).toBeGreaterThan('Review'.length);
  });

  it('and by the FACTOR asked for at +30%, not by some arbitrary amount', () => {
    // 10 characters at 1.3 is 13. Asserting the exact number rather than "longer" is what makes
    // this a measurement instead of a direction: a `repeat(1)` bug returns the input unchanged
    // and still passes a `toBeGreaterThan` assertion.
    expect(expand('No changes', 1.3, parse)).toHaveLength(Math.ceil('No changes'.length * 1.3));
  });

  it('`String.prototype.repeat` COULD NOT HAVE DONE THIS, and that is why it is not used', () => {
    // The trap this file's header warns about, pinned as a test so the warning cannot be deleted
    // while the behaviour it describes is still relied upon.
    expect('Review'.repeat(1.3)).toBe('Review');
    expect(expand('Review', 1.3, parse)).not.toBe('Review');
  });

  it('never SHRINKS a segment, so an under-reported factor cannot hide the tightest case', () => {
    expect(expand('a', 1.3, parse).length).toBeGreaterThanOrEqual(1);
    expect(expand('', 1.3, parse)).toBe('');
  });
});

describe('EXPANSION LEAVES EVERY PLACEHOLDER ALONE, because a translator lengthens prose not syntax', () => {
  it('keeps a `plural` message parseable: one placeholder in, one placeholder out', () => {
    const message = 'in {count, plural, one {# minute} other {# minutes}}';
    expect(placeholdersIn(expand(message, 1.3, parse), parse)).toEqual(
      placeholdersIn(message, parse),
    );
  });

  it('does NOT expand the NUMBERS inside a plural arm, which `#` already substitutes', () => {
    const message = '{count, plural, one {# minute} other {# minutes}}';
    const grown = expand(message, 1.3, parse);
    expect(grown).toContain('# minute');
    expect(grown).toContain('# minutes');
  });

  it('grows the PROSE around a placeholder, and PADS rather than replaces it', () => {
    const message = 'at {when, date, medium}';
    // "at " is three characters, so 1.3 is four, and the segment is padded with `x` rather than
    // substituted -- so the original word survives. My first two expectations here were both wrong:
    // one assumed a trailing space that is not in the message, the other assumed the prose segment
    // was nine characters. Pinning the real value is the point; guessing it twice is why the test
    // now says what the module does instead of what a reader imagined.
    expect(expand(message, 1.3, parse)).toBe('at x{when, date, medium}');
    expect(expand(message, 1.3, parse)).toContain('at ');
  });

  it('does NOT corrupt a NESTED plural, which the obvious regex implementation did', () => {
    // THE REGRESSION TEST FOR THE BUG THIS MODULE HAD. Splitting the message on `(\\{[^{}]*\\})`
    // cannot cross a brace, so on this message it matched only the two inner arms, treated the
    // outer `{count, plural, ...}` and the closing braces as prose, and PADDED THEM. The result
    // ended `}x` and the parser rejected it. Expanding the parsed AST makes that unrepresentable,
    // so the assertion is that the grown message is still ACCEPTED BY THE REAL PARSER.
    const message = 'in {count, plural, one {# minute} other {# minutes}}';
    const grown = expand(message, 1.3, parse);
    expect(() => parseMessage(grown)).not.toThrow();
    expect(grown).toContain('{count, plural, one {');
    expect(grown.endsWith('}}')).toBe(true);
  });

  it('keeps PLACEHOLDER ORDER, because `{a} then {b}` and `{b} then {a}` are different sentences', () => {
    const message = '{first} saved, then {second} released';
    expect(placeholdersIn(expand(message, 1.3, parse), parse)).toEqual(['first', 'second']);
    // And the swapped version is a DIFFERENT message, so a set comparison would have missed it.
    expect(placeholdersIn('{second} released, then {first} saved', parse)).not.toEqual(
      placeholdersIn(message, parse),
    );
  });
});

describe('THE CATALOGUE-WIDE AUDIT CATCHES WHAT A PER-KEY SPOT CHECK WOULD MISS', () => {
  const source = {
    'save.state.saved': 'Saved',
    'deadline.relative.minutes': 'in {count, plural, one {# minute} other {# minutes}}',
  };

  it('reports nothing for the catalogue as shipped', () => {
    expect(auditExpansion(source, source, parse).ok).toBe(true);
  });

  it('CATCHES a translation that DELETED a key, which walking only the catalogue would miss', () => {
    const report = auditExpansion({ 'save.state.saved': 'Saved' }, source, parse);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.detail).toMatch(/absent from the catalogue/);
  });

  it('CATCHES a hard line break, which expansion wraps unpredictably in a fixed-height alert', () => {
    const report = auditExpansion({ ...source, broken: 'Saved\nnow' }, source, parse);
    expect(report.findings.map((f) => f.rule)).toContain('expansion/hard-break');
  });

  it('does NOT re-report a message that was ALREADY invalid, because i18n:check owns that', () => {
    // `Saved {x` does not parse. Reporting it here too would count one defect as two findings,
    // which is how a findings list stops being a list of defects and becomes a total. `i18n:check`
    // reports it once; this audit stays silent.
    const report = auditExpansion({ ...source, '{unclosed': 'Saved {x' }, source, parse);
    expect(report.findings.filter((f) => f.rule === 'expansion/icu-unbalanced')).toHaveLength(0);
  });

  it('and DOES report it when expansion is what broke a message the parser accepted', () => {
    // The guard exists for this case, and after the AST rewrite it is unreachable from `expand()`.
    // It is still asserted through a parser that lies about one specific message, because **a
    // backstop with no test is not a backstop.**
    // Rejects ONLY the padded text. If it rejected the source too the guard would (correctly)
    // skip the key, so the stub has to distinguish the two -- which is the whole point of the
    // guard: it reports breakage CAUSED by expansion, not breakage that was already there.
    const picky = (pattern: string): readonly MessageNode[] => {
      if (pattern.includes('x')) throw new Error('padded text is not valid here');
      return parseMessage(pattern);
    };
    const report = auditExpansion(
      { ...source, Sensitive: 'Saved' },
      { ...source, Sensitive: 'Saved' },
      picky,
    );
    expect(report.findings.map((f) => f.rule)).toContain('expansion/icu-unbalanced');
  });

  it('reports EVERY affected key, not a count', () => {
    const report = auditExpansion({}, { a: 'x', b: 'y', c: 'z' }, parse);
    expect(report.findings).toHaveLength(3);
    expect(report.checked).toBe(3);
  });

  it('names the factor it used, so a passing report cannot be read as "expansion is safe" in general', () => {
    expect(auditExpansion(source, source, parse).factor).toBe(EXPANSION_FACTOR);
  });
});
