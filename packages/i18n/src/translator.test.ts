/**
 * The `Intl` accessor and the translator that consumes it.  (P13-T7)
 *
 * ## THE PROPERTY THAT MATTERS HERE IS "REACHABLE WITHOUT ROLLING YOUR OWN"
 *
 * `P13-T7` asks for `Intl.DateTimeFormat(locale)` to be usable from a component without importing a
 * formatter by hand. So the tests are about the ACCESS POINT — that it exists, that it is memoised so
 * two call sites share one formatter, and that it cannot be made to render in the host's zone or throw
 * on a zone read from a profile.
 */

import { describe, expect, it, vi } from 'vitest';
import { CATALOGUES, enGB, enUS } from './catalogues.js';
import {
  FALLBACK_ZONE,
  formatterCacheSize,
  formattersFor,
  localeFormatters,
  pluralCategories,
} from './index.js';
import { hasPluralCategoryList } from './intl.js';
import { createTranslator, type MessageIssue } from './translator.js';

describe('the accessor exists, and a component needs nothing else to format a date', () => {
  it('gives a working DateTimeFormat for a locale with no imports beyond this package', () => {
    const dtf = localeFormatters('en-GB').dateTime({ dateStyle: 'medium' });
    expect(dtf.format(Date.parse('2026-09-27T12:00:00Z'))).toBe('27 Sept 2026');
    expect(dtf.resolvedOptions().locale).toBe('en-GB');
  });

  it('MEMOISES, so two call sites asking the same thing share one formatter', () => {
    // The reason this is not merely an optimisation: a component rendering 200 rows formats 200 date
    // columns, and a fresh `Intl.DateTimeFormat` per column is 200 ICU initialisations.
    const before = formatterCacheSize();
    const a = localeFormatters('fr-FR').dateTime({ dateStyle: 'short' });
    const afterFirst = formatterCacheSize();
    const b = localeFormatters('fr-FR').dateTime({ dateStyle: 'short' });
    expect(b).toBe(a);
    expect(afterFirst).toBe(before + 1);
  });

  it('does NOT share across DIFFERENT options, which would silently apply the wrong format', () => {
    const f = localeFormatters('fr-FR');
    expect(f.dateTime({ dateStyle: 'short' })).not.toBe(f.dateTime({ dateStyle: 'long' }));
  });

  it('a DIFFERENT locale is a DIFFERENT formatter', () => {
    const f = localeFormatters('en-GB');
    expect(f.number()).not.toBe(localeFormatters('en-US').number());
  });

  it('gives a plural rules object, which is the thing `n === 1` cannot replace', () => {
    expect(localeFormatters('pl').pluralRules().select(5)).toBe('many');
    expect(localeFormatters('en-GB').pluralRules().select(5)).toBe('other');
  });

  it('gives number and relative-time formatters in the locale', () => {
    const f = localeFormatters('de-DE');
    expect(f.number().format(1234)).toBe('1.234');
    expect(f.relativeTime({ numeric: 'auto' }).format(-1, 'day')).toBe('gestern');
  });

  it('defaults an omitted locale rather than asking `Intl` to guess from the host', () => {
    // `formatDate()` with no locale follows the HOST's language on a build server, which is how a
    // date in a screenshot stops matching the product.
    expect(formattersFor().dateTime().resolvedOptions().locale).toBe('en-GB');
    expect(formattersFor('').dateTime().resolvedOptions().locale).toBe('en-GB');
  });

  it('FALLS BACK TO UTC on a zone that does not exist, rather than throwing RangeError', () => {
    // `new Intl.DateTimeFormat('en-GB', { timeZone: 'Not/AZone' })` throws. A `timeZone` read from a
    // profile is exactly that, and a throw inside a render takes the page down.
    const dtf = localeFormatters('en-GB').dateTime({ timeZone: 'Not/AZone' });
    expect(dtf.resolvedOptions().timeZone).toBe(FALLBACK_ZONE);
    expect(dtf.resolvedOptions().timeZone).toBe('UTC');
  });

  it('honours a REAL zone, so the fallback is not just "always UTC"', () => {
    const dtf = localeFormatters('en-GB').dateTime({
      timeZone: 'Asia/Kolkata',
      timeStyle: 'short',
    });
    // ICU canonicalises the tag, so the assertion is on the CLOCK rather than on the alias ICU chose —
    // `Asia/Calcutta` and `Asia/Kolkata` are the same zone and the choice is not ours.
    expect(dtf.format(Date.parse('2026-09-27T12:00:00Z'))).toBe('17:30');
    // ...and the same instant in UTC is a different clock reading, which is the point of naming a zone.
    expect(dtf.format(Date.parse('2026-09-27T12:00:00Z'))).not.toBe(
      localeFormatters('en-GB')
        .dateTime({ timeStyle: 'short' })
        .format(Date.parse('2026-09-27T12:00:00Z')),
    );
  });
});

describe('pluralCategories asks ICU rather than carrying a table', () => {
  it('reports the REAL category sets, and the runtime really exposes the list', () => {
    // The `?? [...]` branch in `pluralCategories` is only safe if the list is present; if it were not,
    // every message would be judged against the full six-category set and no English catalogue could
    // ever pass.
    expect(hasPluralCategoryList()).toBe(true);
    expect([...pluralCategories('en-GB')].sort()).toEqual(['one', 'other']);
    expect([...pluralCategories('pl')].sort()).toEqual(['few', 'many', 'one', 'other']);
    expect([...pluralCategories('ar')].sort()).toEqual([
      'few',
      'many',
      'one',
      'other',
      'two',
      'zero',
    ]);
  });

  it('reports a DIFFERENT set per locale, which is the whole point of asking', () => {
    expect([...pluralCategories('fa')].sort()).toEqual(['one', 'other']);
    expect(pluralCategories('pl')).not.toEqual(pluralCategories('en-GB'));
  });
});

describe('the translator degrades one string rather than the page', () => {
  const issues: MessageIssue[] = [];
  const t = createTranslator(enGB, { locale: 'en-GB', onIssue: (i) => issues.push(i) });

  it('renders a catalogue message', () => {
    expect(t('save.state.saved')).toBe('Saved');
    expect(t.locale).toBe('en-GB');
  });

  it('renders a plural message through ICU', () => {
    expect(t('save.conflict.detail', { count: 1 })).toBe('1 block needs a decision');
    expect(t('save.conflict.detail', { count: 3 })).toBe('3 blocks need a decision');
  });

  it('renders a date in the locale and the zone, and NOT as an ISO timestamp', () => {
    const out = t('save.saved.at', { when: new Date(Date.parse('2026-09-27T12:00:00Z')) });
    expect(out).toBe('at 27 Sept 2026, 12:00');
    // The reason this is a message: `2026-09-27T12:00:00.000Z` in a `role="status"` is read aloud as
    // a stream of letters and digits with no word boundaries.
    expect(out).not.toMatch(/^\s*\d{4}-\d{2}-\d{2}T/);
  });

  it('DEFAULTS to UTC, because a date with no zone is a date on the CI server', () => {
    expect(t.timeZone).toBe('UTC');
    const explicit = createTranslator(enGB, {
      locale: 'en-GB',
      timeZone: 'Asia/Tokyo',
      onIssue: () => undefined,
    });
    expect(explicit('save.saved.at', { when: new Date(Date.parse('2026-09-27T12:00:00Z')) })).toBe(
      'at 27 Sept 2026, 21:00',
    );
  });

  it('RENDERS THE KEY, NOT ENGLISH, for a key the catalogue lacks', () => {
    // A complete catalogue makes this unreachable through `createTranslator`, which is the type-level
    // guarantee. It is reached here by casting, because the runtime twin has to exist too — for a
    // catalogue loaded from JSON, where the union did not shrink with the key.
    const incomplete = { ...enUS } as Partial<typeof enUS>;
    delete incomplete['save.state.dirty'];
    const seen: MessageIssue[] = [];
    const broken = createTranslator(incomplete as typeof enGB, {
      locale: 'en-US',
      onIssue: (i) => seen.push(i),
    });
    expect(broken('save.state.dirty')).toBe('save.state.dirty');
    // ...and NOT `'Unsaved changes'`, which is what an English fallback would render and what would
    // look, to every reviewer, like a working translation.
    expect(broken('save.state.dirty')).not.toBe('Unsaved changes');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({
      kind: 'missing-key',
      locale: 'en-US',
      key: 'save.state.dirty',
      detail: 'no entry for "save.state.dirty" in the en-US catalogue',
    });
  });

  it('REPORTS a missing argument rather than printing `undefined`', () => {
    const seen: MessageIssue[] = [];
    const reporter = createTranslator(enGB, { locale: 'en-GB', onIssue: (i) => seen.push(i) });
    expect(reporter('save.failure.detail')).toBe('{reason}: {count} so far.');
    // `{reason}` absent is `missing-argument` and `{count, plural}` absent is the same kind, not a
    // type error: `undefined` is "not supplied", which is a different bug from "supplied wrong".
    expect(seen.map((i) => i.kind)).toEqual(['missing-argument', 'missing-argument']);
    // The key rides along on every report, so an operator sees WHICH message to fix.
    expect(seen.every((i) => i.key === 'save.failure.detail')).toBe(true);
  });

  it('REPORTS a wrong-typed argument, because `{count, plural}` with a string is a caller bug', () => {
    const seen: MessageIssue[] = [];
    const reporter = createTranslator(enGB, { locale: 'en-GB', onIssue: (i) => seen.push(i) });
    expect(reporter('save.conflict.detail', { count: '3' })).toBe('{count} decision');
    expect(seen).toEqual([
      {
        kind: 'bad-argument',
        locale: 'en-GB',
        key: 'save.conflict.detail',
        detail: '`{count, plural}` needs a number, got string',
      },
    ]);
  });

  it('REQUIRES a reporter: there is no default that can be left unset', () => {
    // A defaulted `onIssue` is a reporter nobody sets, so the gate's guarantee would hold only for
    // tests. This is asserted by the TYPE, and this call is what the type rejects.
    const withoutReporter = createTranslator(enGB, { locale: 'en-GB' });
    expect(typeof withoutReporter).toBe('function');
    // The type error is the guarantee; the runtime still works, which is why the comment above the
    // constructor is load-bearing rather than decorative.
    // @ts-expect-error onIssue is required so a gap cannot be silent
    createTranslator(enGB, { locale: 'en-GB' });
  });
});

describe('the two shipped locales render differently, and the audit says why that is enough', () => {
  it('`en-US` formats a date the American way, through the same code path', () => {
    const at = new Date(Date.parse('2026-09-27T12:00:00Z'));
    const gb = createTranslator(enGB, { locale: 'en-GB', onIssue: () => undefined });
    const us = createTranslator(enUS, { locale: 'en-US', onIssue: () => undefined });
    expect(gb('save.saved.at', { when: at })).toBe('at 27 Sept 2026, 12:00');
    expect(us('save.saved.at', { when: at })).toBe('at Sep 27, 2026, 12:00 PM');
    // Identical keys, different output — the second locale is not theatre.
    expect(gb('save.state.saved')).toBe(us('save.state.saved'));
  });

  it('`CATALOGUES` is the only list a caller should have to consult', () => {
    expect(Object.keys(CATALOGUES)).toEqual(['en-GB', 'en-US']);
  });

  it('an UNKNOWN locale falls back to the SOURCE catalogue rather than throwing', () => {
    // A stored profile may carry a locale this build does not ship; a 500 over a settings row is not
    // an acceptable way to express that.
    const reporter = vi.fn();
    const unknown = createTranslator(enGB, { locale: 'de-DE', onIssue: reporter });
    expect(unknown('save.state.saved')).toBe('Saved');
    expect(reporter).not.toHaveBeenCalled();
  });
});
