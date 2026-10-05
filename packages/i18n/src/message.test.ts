/**
 * The message compiler, and above all the plural selection.  (P13-T7)
 *
 * ## WHY THE PLURAL TESTS ARE NOT WRITTEN IN ENGLISH
 *
 * **AN ENGLISH PLURAL TEST CANNOT TELL A REAL ICU IMPLEMENTATION FROM A TWO-FORM CONDITIONAL.**
 * `n === 1 ? 'minute' : 'minutes'` and `Intl.PluralRules` agree on every integer in English, so a
 * suite written only in English passes either implementation and proves nothing about either. The
 * tests here therefore drive Polish (`one`, `few`, `many`, `other`) and Arabic (`zero`, `one`, `two`,
 * `few`, `many`, `other`), whose category boundaries land on values English never visits.
 *
 * If the arm selection is replaced with a two-form conditional, `PLURAL: POLISH HAS FOUR FORMS`
 * fails on `few`/`many` and nothing else in this file has to be read to see why.
 */

import { describe, expect, it } from 'vitest';
import {
  compiledCount,
  formatMessage,
  MessageSyntaxError,
  PluralCategoryGapError,
  parseMessage,
  placeholdersIn,
} from './index.js';
import { categoriesCovered } from './message.js';

const AT = Date.parse('2026-09-27T12:00:00Z');
const render = (pattern: string, args: Record<string, string | number | Date>, locale = 'en-GB') =>
  formatMessage(pattern, args, { locale, timeZone: 'UTC' });

describe('THE test: plural categories are chosen by ICU, not by `n === 1`', () => {
  /** Real Polish words for a count of minutes. A two-form English conditional cannot produce these. */
  const PL = '{count, plural, one {# minuta} few {# minuty} many {# minut} other {# minuty}}';
  const CATEGORY =
    '{count, plural, one {one} two {two} few {few} many {many} zero {zero} other {other}}';

  it('POLISH HAS FOUR FORMS, and a two-form conditional gets two of them wrong', () => {
    // The CLDR boundaries, read off `Intl.PluralRules('pl')`: 1 is `one`, 2 is `few`, 5 is `many`,
    // 1.5 is `other`.
    expect(render(PL, { count: 1 }, 'pl')).toBe('1 minuta');
    expect(render(PL, { count: 2 }, 'pl')).toBe('2 minuty');
    expect(render(PL, { count: 5 }, 'pl')).toBe('5 minut');
    expect(render(PL, { count: 22 }, 'pl')).toBe('22 minuty');
    expect(render(PL, { count: 1.5 }, 'pl')).toBe('1,5 minuty');
  });

  it('ARABIC HAS SIX CATEGORIES, and reaches `zero` at 0 and `two` at 2 — which English has no word for', () => {
    // `ar` resolves its plural rules independently of its digits, so the categories are asserted in
    // `ar` and the DIGITS are asserted separately in `ar-EG`, where CLDR selects arabic-indic numerals.
    expect(render(CATEGORY, { count: 0 }, 'ar')).toBe('zero');
    expect(render(CATEGORY, { count: 1 }, 'ar')).toBe('one');
    expect(render(CATEGORY, { count: 2 }, 'ar')).toBe('two');
    expect(render(CATEGORY, { count: 3 }, 'ar')).toBe('few');
    expect(render(CATEGORY, { count: 11 }, 'ar')).toBe('many');
    expect(render(CATEGORY, { count: 100 }, 'ar')).toBe('other');
  });

  it('DIGITS ARE A SEPARATE PROPERTY, and `ar-EG` is not `ar`', () => {
    // `Intl.NumberFormat('ar')` is `latn` in current CLDR and `ar-EG` is `arab`. A translator who
    // tested one and assumed the other shipped Latin digits to every Arabic reader.
    expect(render('{n, number}', { n: 1234 }, 'ar')).toBe('1,234');
    expect(render('{n, number}', { n: 1234 }, 'ar-EG')).toBe('١٬٢٣٤');
  });

  it('THE RULES ARE PER-LOCALE, NOT PER-LANGUAGE FAMILY: Polish 21 is `many` and Russian 21 is `one`', () => {
    // Two locales, one number, two different grammatical numbers. A hardcoded table of "languages
    // with slavic plurals" gets this pair wrong whichever way it guesses.
    expect(render(CATEGORY, { count: 21 }, 'pl')).toBe('many');
    expect(render(CATEGORY, { count: 21 }, 'ru')).toBe('one');
    // Czech has three categories and a very different `one` boundary again: only 1.
    expect(render(CATEGORY, { count: 1 }, 'cs')).toBe('one');
    expect(render(CATEGORY, { count: 21 }, 'cs')).toBe('other');
  });

  it('PERSEAN HAS TWO, LIKE ENGLISH, WHICH IS WHY ENGLISH IS NOT A SAFE PROXY FOR ANYTHING', () => {
    // `fa` is `one`/`other`. A framework proven only on English and Polish could still have hardcoded
    // a Slavic rule table; this is the case that would have passed.
    expect(render(CATEGORY, { count: 1 }, 'fa')).toBe('one');
    expect(render(CATEGORY, { count: 2 }, 'fa')).toBe('other');
  });

  it('`n === 1` and `Intl.PluralRules` agree in English, WHICH IS WHY AN ENGLISH-ONLY TEST PROVES NOTHING', () => {
    // Written as a property of the comparison rather than of the message: the numbers below are the
    // ones a two-form conditional happens to get right in English.
    const naive = (n: number) => (n === 1 ? 'minute' : 'minutes');
    for (const n of [0, 1, 2, 5, 100]) {
      expect(
        render('{count, plural, one {# minute} other {# minutes}}', { count: n }, 'en-GB'),
      ).toBe(`${String(n)} ${String(naive(n))}`);
    }
    // ...and the same two-form naive rule, asked about Polish, is wrong at 2 and at 5.
    const naivePl = (n: number) => (n === 1 ? 'minuta' : 'minuty');
    expect(naivePl(5)).toBe('minuty');
    expect(render(PL, { count: 5 }, 'pl')).toBe('5 minut');
  });

  it('an EXACT selector beats the category, in every locale', () => {
    const message =
      '{count, plural, =0 {no answers} =1 {the only answer} one {# answer} other {# answers}}';
    expect(render(message, { count: 0 }, 'en-GB')).toBe('no answers');
    expect(render(message, { count: 1 }, 'en-GB')).toBe('the only answer');
    expect(render(message, { count: 2 }, 'en-GB')).toBe('2 answers');
    // `=0` is a number, not a category, so it holds in Polish too — where `0` would otherwise be
    // `many`.
    expect(render(message, { count: 0 }, 'pl')).toBe('no answers');
  });

  it('`#` INSIDE AN ARM IS THE LOCALE`S NUMBER, not the raw digits', () => {
    // de-DE groups with a full stop; en-GB with a comma. A hand-built `String(n)` gets this wrong in
    // every locale that groups differently, and a screen reader then says "one point two three four"
    // rather than "one thousand two hundred and thirty four".
    expect(render('{n, plural, other {#}}', { n: 1234 }, 'de-DE')).toBe('1.234');
    expect(render('{n, plural, other {#}}', { n: 1234 }, 'en-GB')).toBe('1,234');
    expect(render('{n, plural, other {#}}', { n: 1234 }, 'en-US')).toBe('1,234');
  });

  it('`#` IS ONLY MEANINGFUL INSIDE AN ARM, and a bare `#` elsewhere is literal text', () => {
    // Documenting the boundary so a future reader does not expect the sigil to work at top level.
    expect(render('issue #12', {}, 'en-GB')).toBe('issue #12');
    expect(render('{n, plural, other {see # above}}', { n: 2 }, 'en-GB')).toBe('see 2 above');
  });

  it('a NESTED plural resolves against ITS OWN argument, not the outer one', () => {
    const message =
      '{outer, plural, other {{inner, plural, one {one inner} other {# inners}} for {outer} outer}}';
    expect(render(message, { outer: 2, inner: 1 }, 'en-GB')).toBe('one inner for 2 outer');
    expect(render(message, { outer: 2, inner: 3 }, 'en-GB')).toBe('3 inners for 2 outer');
  });

  it('THROWS when the locale selects a category the message does not cover', () => {
    // The asymmetry stated in `./message.ts`: a missing key degrades a string, but an uncovered
    // plural category would print a sentence in the wrong grammatical number, quietly.
    const twoForms = '{count, plural, one {# answer} other {# answers}}';
    expect(() => render(twoForms, { count: 5 }, 'pl')).toThrow(PluralCategoryGapError);
    // ...and the error says which categories are needed, because "it threw" is not actionable.
    try {
      render(twoForms, { count: 5 }, 'pl');
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as PluralCategoryGapError;
      expect(e.locale).toBe('pl');
      expect(e.category).toBe('many');
      expect(e.covered).toEqual(['one']);
      // ...and it names EVERY category Polish needs, so a translator is not left guessing which of
      // `few`/`many` was the one that failed.
      expect([...e.missing].sort()).toEqual(['few', 'many']);
      expect(e.message).toContain('few');
      expect(e.message).toContain('many');
    }
  });

  it('does NOT silently fall back to `other` for an uncovered category', () => {
    // A fallback would return `'5 answers'` here, which is indistinguishable from correct output to
    // every reader who does not speak Polish. That indistinguishability is the whole problem.
    const twoForms = '{count, plural, one {# answer} other {# answers}}';
    let rendered: string | null = null;
    try {
      rendered = render(twoForms, { count: 5 }, 'pl');
    } catch {
      rendered = null;
    }
    expect(rendered).toBeNull();
  });
});

describe('the parser rejects what it does not understand, rather than ignoring it', () => {
  const bad = (pattern: string) => () =>
    formatMessage(pattern, {}, { locale: 'en-GB', timeZone: 'UTC' });

  it('rejects an unclosed placeholder', () => {
    expect(bad('{count')).toThrow(MessageSyntaxError);
    expect(bad('{count, plural, one {x} other {y}')).toThrow(MessageSyntaxError);
  });

  it('rejects a `plural` with no `other` arm, because ICU requires one', () => {
    expect(bad('{count, plural, one {# thing}}')).toThrow(MessageSyntaxError);
    // ...and the message says WHY, since an author who does not know ICU needs the rule, not the fact.
    expect(bad('{count, plural, one {# thing}}')).toThrow(/needs an `other` arm/);
  });

  it('rejects a `select` with no `other` arm on the same grounds', () => {
    expect(bad('{gender, select, female {she} other {they}}')).not.toThrow();
    expect(bad('{gender, select, female {she} male {he}}')).toThrow(/needs an `other` arm/);
  });

  it('rejects an unknown argument type instead of rendering it literally', () => {
    expect(bad('{when, time}')).toThrow(/unsupported placeholder type/);
    expect(bad('{n, number, currency}')).toThrow(/unsupported number style/);
    expect(bad('{when, date, epoch}')).toThrow(/unsupported date style/);
  });

  it('rejects ICU literal tags, because a message renders plain text to a student', () => {
    // `<b>bold</b>` reaching a screen is markup injection through the translator, and the failure is
    // invisible in the catalogue — the catalogue looks correct.
    expect(bad('<b>bold</b>')).toThrow(/literal tags are not supported/);
  });

  it('rejects a stray closing brace', () => {
    expect(bad('trailing }')).toThrow(/unexpected/);
  });

  it('quotes the offending pattern into the syntax error, so the message is actionable', () => {
    try {
      parseMessage('{n, number, currency}');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as MessageSyntaxError).pattern).toBe('{n, number, currency}');
      expect((error as MessageSyntaxError).message).toContain('currency');
    }
  });

  it('an APOSTROPHE IS NOT AN ESCAPE CHARACTER, so ordinary copy parses', () => {
    // Half this product's copy has an apostrophe. A subset that made `'` special would need a
    // doubling rule to write "Couldn't save".
    expect(render("Couldn't save", {}, 'en-GB')).toBe("Couldn't save");
    expect(render("Someone else's", {}, 'en-GB')).toBe("Someone else's");
  });
});

describe('the other argument types', () => {
  it('substitutes a plain argument as a string', () => {
    expect(render('{reason}: retrying', { reason: 'offline' }, 'en-GB')).toBe('offline: retrying');
  });

  it('formats a number in the LOCALE, which is not the same as `String(n)`', () => {
    expect(render('{n, number}', { n: 1234.5 }, 'en-GB')).toBe('1,234.5');
    expect(render('{n, number}', { n: 1234.5 }, 'de-DE')).toBe('1.234,5');
  });

  it('formats a percent, which the compiler cannot fake by appending a sign', () => {
    expect(render('{n, number, percent}', { n: 0.25 }, 'en-GB')).toBe('25%');
  });

  it('formats a date in the locale AND in the zone it was given', () => {
    expect(render('{when, date, medium}', { when: new Date(AT) }, 'en-GB')).toBe(
      '27 Sept 2026, 12:00',
    );
    expect(render('{when, date, medium}', { when: new Date(AT) }, 'en-US')).toBe(
      'Sep 27, 2026, 12:00 PM',
    );
    // The same instant in two zones is two different times, and a formatter that ignored the zone
    // would render the CI server's local time.
    expect(
      formatMessage(
        '{when, date, time}',
        { when: new Date(AT) },
        { locale: 'en-GB', timeZone: 'Asia/Tokyo' },
      ),
    ).toBe('21:00');
    expect(
      formatMessage(
        '{when, date, time}',
        { when: new Date(AT) },
        { locale: 'en-GB', timeZone: 'UTC' },
      ),
    ).toBe('12:00');
  });

  it('each date style is a different format, and none of them is an ISO timestamp', () => {
    // The reason `save.saved.at` is a message and not `toISOString()`: an ISO string read aloud by a
    // screen reader is letters, digits and punctuation with no word boundaries.
    expect(render('{when, date, short}', { when: new Date(AT) }, 'en-GB')).toBe('27/09/2026');
    expect(render('{when, date, long}', { when: new Date(AT) }, 'en-GB')).toBe(
      '27 September 2026 at 12:00',
    );
    expect(render('{when, date, time}', { when: new Date(AT) }, 'en-GB')).toBe('12:00');
  });

  it('selects on a `select` argument and says so when no arm matches', () => {
    const issues: string[] = [];
    const pattern = '{role, select, teacher {Teacher} student {Student} other {Guest}}';
    expect(
      formatMessage(pattern, { role: 'teacher' }, { locale: 'en-GB', timeZone: 'UTC' }, (i) =>
        issues.push(i.kind),
      ),
    ).toBe('Teacher');
    expect(
      formatMessage(pattern, { role: 'head' }, { locale: 'en-GB', timeZone: 'UTC' }, (i) =>
        issues.push(i.kind),
      ),
    ).toBe('{role}');
    expect(issues).toEqual(['no-select-arm']);
  });

  it('REPORTS a missing argument and shows the brace, rather than rendering `undefined`', () => {
    // `undefined` on a student's screen is worse than the brace: the brace names the bug.
    const issues: string[] = [];
    const out = formatMessage('{count} answers', {}, { locale: 'en-GB', timeZone: 'UTC' }, (i) =>
      issues.push(`${i.kind}: ${i.detail}`),
    );
    expect(out).toBe('{count} answers');
    expect(issues).toEqual(['missing-argument: `{count}` has no argument']);
  });

  it('REPORTS a wrong-typed argument, because `{n, plural}` with a string is a caller bug', () => {
    const issues: string[] = [];
    const out = formatMessage(
      '{n, plural, one {#} other {#}}',
      { n: '3' },
      { locale: 'en-GB', timeZone: 'UTC' },
      (i) => issues.push(i.kind),
    );
    expect(out).toBe('{n}');
    expect(issues).toEqual(['bad-argument']);
  });

  it('REPORTS a `date` given a number, which is the exact mistake `Millis` invites', () => {
    const issues: string[] = [];
    const out = formatMessage(
      '{when, date}',
      { when: AT },
      { locale: 'en-GB', timeZone: 'UTC' },
      (i) => issues.push(i.kind),
    );
    expect(out).toBe('{when}');
    expect(issues).toEqual(['bad-argument']);
  });
});

describe('placeholders and coverage are READABLE, because the gate reads them', () => {
  it('lists every argument a message reads, nested arms included', () => {
    const names = placeholdersIn(
      parseMessage('{a} and {b, number} and {c, plural, one {{d, date}} other {#}}'),
    );
    expect([...names].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does NOT count `other` or `=0` as a plural CATEGORY', () => {
    // `other` is ICU's fallback arm, not a grammatical form; counting it would make every two-form
    // message look like it covered every locale.
    expect([...categoriesCovered('{n, plural, =0 {none} other {# things}}')]).toEqual([]);
    expect([...categoriesCovered('{n, plural, one {# thing} other {# things}}')]).toEqual(['one']);
    expect([...categoriesCovered('{n, plural, one {} few {} many {} other {}}')].sort()).toEqual([
      'few',
      'many',
      'one',
    ]);
  });

  it('MEMOISES compilation, so a repeated message is parsed once', () => {
    const pattern = '{n, plural, one {# memoised} other {# memoised}}';
    const before = compiledCount();
    render(pattern, { n: 1 });
    const after = compiledCount();
    render(pattern, { n: 2 });
    expect(compiledCount()).toBe(after);
    expect(after).toBeGreaterThan(before);
  });
});
