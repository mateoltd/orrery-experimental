/**
 * The completeness audit, and the point of this file: EVERY RULE IS PROVEN BY A PLANTED VIOLATION.
 *
 * ## WHY A GATE TEST THAT ONLY RUNS ON CLEAN DATA PROVES NOTHING
 *
 * `scripts/i18n-check.mjs` is a process that exits. The only way to know its rules fire is to feed it
 * data that violates each one and see it fail, which is why every case below plants a violation
 * rather than asserting the audit passes. A green gate for a rule that no test has ever seen fail is
 * indistinguishable from a rule that does not exist — which is the shape of the `a11y` step that
 * `ci.yml` carried before `P13-T1` built it.
 *
 * The catalogues here are THROWAWAY. They are not `enGB`/`enUS`; they exist to violate one rule each.
 */

import { describe, expect, it } from 'vitest';
import { auditCatalogues } from './audit.js';
import {
  CATALOGUES,
  enGB,
  enUS,
  isCompleteCatalogue,
  missingKeys,
  orphanKeys,
} from './catalogues.js';
// `SOURCE_LOCALE` lives in `./locale.ts` rather than in `./catalogues.ts`, because that file is the one
// `scripts/i18n-check.mjs` can load with Node's type stripping (no relative imports) and the gate
// needs the declared source from a file it can actually reach.
import { SOURCE_LOCALE } from './locale.js';

/** The real catalogues, spread so a planted violation cannot mutate them. */
const clean = () => ({
  'en-GB': { ...enGB },
  'en-US': { ...enUS },
});

const audit = (catalogues: Record<string, Record<string, string>>) =>
  auditCatalogues({ sourceLocale: SOURCE_LOCALE, catalogues });

const rulesFor = (catalogues: Record<string, Record<string, string>>, rule: string) =>
  audit(catalogues).findings.filter((f) => f.rule === rule);

/**
 * The source copy with EVERY plural message given Polish arms.
 *
 * Without this the `pl` fixtures are English text wearing a Polish locale tag, and the audit is right
 * to reject all five plural messages in them — which is the gate working, not the fixture. A fixture
 * for a four-form locale has to be a four-form catalogue.
 */
const plOf = (over: Record<string, string> = {}): Record<string, string> => ({
  ...enGB,
  'deadline.relative.minutes':
    'za {count, plural, one {# minutę} few {# minuty} many {# minut} other {# minuty}}',
  'deadline.relative.hours':
    'za {count, plural, one {# godzinę} few {# godziny} many {# godzin} other {# godziny}}',
  'deadline.relative.days':
    'za {count, plural, one {# dzień} few {# dni} many {# dni} other {# dnia}}',
  'save.failure.detail':
    '{reason}: {count, plural, one {# próba} few {# próby} many {# prób} other {# próby}} do tej pory.',
  'save.conflict.detail':
    '{count, plural, one {# blok wymaga} few {# bloki wymagają} many {# bloków wymaga} other {# bloku wymaga}} decyzji',
  ...over,
});

describe('the real catalogues pass, which is the only reason the negative cases below mean anything', () => {
  it('reports no findings and names the source locale first', () => {
    const report = audit(clean());
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.sourceLocale).toBe('en-GB');
    // The source is FIRST, because "which catalogue is authoritative" is the first question a reader
    // of this output has and `Object.keys` order would not answer it.
    expect(report.locales[0]).toBe('en-GB');
    expect(report.keyCount).toBe(Object.keys(enGB).length);
  });

  it('every shipped catalogue is complete, so the TYPE-level guarantee is not being argued from theory', () => {
    for (const [tag, catalogue] of Object.entries(CATALOGUES)) {
      expect(isCompleteCatalogue(catalogue), tag).toBe(true);
      expect(orphanKeys(catalogue), tag).toEqual([]);
      expect(missingKeys(catalogue), tag).toEqual([]);
    }
  });
});

describe('missing key — a crash at render time, which is what this prevents', () => {
  it('CATCHES it, and NAMES the key rather than counting them', () => {
    const c = clean();
    delete c['en-US']['save.state.dirty'];
    delete c['en-US']['save.action.retry'];
    const findings = rulesFor(c, 'missing-key');
    expect(findings.map((f) => f.key)).toEqual(['save.action.retry', 'save.state.dirty']);
    // Every finding names its locale too, so a report with six locales does not need cross-referencing.
    expect(findings.every((f) => f.locale === 'en-US')).toBe(true);
    expect(findings[0]?.detail).toContain('en-GB');
  });

  it('fails the whole audit, not just the rule', () => {
    const c = clean();
    delete c['en-US']['save.state.dirty'];
    expect(audit(c).ok).toBe(false);
  });

  it('reports a missing SOURCE catalogue rather than passing on an empty comparison', () => {
    // The gate that checks nothing must fail, or a renamed locale ships with a green tick.
    const report = auditCatalogues({ sourceLocale: 'en-GB', catalogues: { 'en-US': { ...enUS } } });
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.key).toBe('<source catalogue>');
  });

  it('reports EVERY locale missing the same key, so fixing it once is possible', () => {
    const source = { ...enGB, 'x.count': '{n, plural, one {# thing} other {# things}}' };
    const report = auditCatalogues({
      sourceLocale: 'en-GB',
      catalogues: { 'en-GB': source, 'en-US': {}, 'fr-FR': {} },
    });
    const findings = report.findings.filter((f) => f.rule === 'missing-key');
    // One finding per (locale, key) — 17 keys × 2 locales — and BOTH locales are named, so the
    // reader learns the translation is missing everywhere rather than only where they happened to look.
    expect([...new Set(findings.map((f) => f.locale))]).toEqual(['en-US', 'fr-FR']);
    expect(findings).toHaveLength(Object.keys(source).length * 2);
  });
});

describe('orphan key — present in a translation, absent from the source', () => {
  it('CATCHES it, and says the source does not have it', () => {
    // This is the case that makes the source locale worth printing. Three keys deleted from `en-GB`
    // and left in `en-US` is symmetric with three keys deleted from `en-US`, and only the source
    // declaration tells them apart.
    const c = clean();
    c['en-US']['save.state.retired'] = 'Retired';
    const findings = rulesFor(c, 'orphan-key');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('save.state.retired');
    expect(findings[0]?.detail).toContain('en-GB');
  });

  it('does NOT report a source key as an orphan in the source catalogue', () => {
    expect(rulesFor(clean(), 'orphan-key')).toEqual([]);
  });
});

describe('placeholder mismatch — the check worth more than the key count', () => {
  it('CATCHES a translation that DROPPED `{count}`, and names both sides', () => {
    // A translation that drops `{count}` renders a literal brace to a student mid-exam. This is the
    // specific failure the task names, and a key-count check cannot see it: the key is present.
    const c = clean();
    c['en-US']['save.failure.detail'] = '{reason}: a few attempts so far.';
    const findings = rulesFor(c, 'placeholder-mismatch');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('save.failure.detail');
    expect(findings[0]?.detail).toContain('dropped: {count}');
  });

  it('CATCHES a translation that RENAMED `{count}` to `{n}`', () => {
    // The silent one: the key exists, the string parses, the count renders as `{n}`.
    const c = clean();
    c['en-US']['save.failure.detail'] =
      '{reason}: {n, plural, one {# attempt} other {# attempts}} so far.';
    const findings = rulesFor(c, 'placeholder-mismatch');
    expect(findings[0]?.detail).toContain('dropped: {count}');
    expect(findings[0]?.detail).toContain('invented: {n}');
  });

  it('CATCHES an INVENTED placeholder the source never had', () => {
    const c = clean();
    c['en-US']['save.state.saved'] = 'Saved by {author}';
    expect(rulesFor(c, 'placeholder-mismatch')[0]?.detail).toContain('invented: {author}');
  });

  it('compares against the SOURCE, not against the other translations', () => {
    // Two identical typos in `en-GB` and `en-US` agree with each other and still disagree with the
    // component that calls `t('save.failure.detail', { count })`. Comparing translations to each
    // other proves they agree, which is not the property that matters.
    const c = clean();
    c['en-GB']['save.failure.detail'] =
      '{reason}: {n, plural, one {# attempt} other {# attempts}} so far.';
    c['en-US']['save.failure.detail'] = c['en-GB']['save.failure.detail'];
    // The source's own set is what every locale is measured against, so this is not a finding here:
    const report = audit(c);
    expect(report.findings.filter((f) => f.rule === 'placeholder-mismatch')).toEqual([]);
    // ...which is why the source is ALSO compiled at all: a message that does not parse there fails
    // as `unparseable` rather than being compared against nothing.
    expect(report.ok).toBe(true);
  });
});

describe('plural coverage — checked against ICU, never against a hardcoded table', () => {
  it('CATCHES a two-form message asked to serve Polish', () => {
    const report = auditCatalogues({
      sourceLocale: 'en-GB',
      catalogues: {
        'en-GB': { ...enGB, 'x.count': '{n, plural, one {# thing} other {# things}}' },
        pl: plOf({ 'x.count': '{n, plural, one {# rzecz} other {# rzeczy}}' }),
      },
    });
    const findings = report.findings.filter((f) => f.rule === 'plural-coverage');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.locale).toBe('pl');
    // ...and it names BOTH missing categories, so a translator is told what to add.
    expect(findings[0]?.detail).toContain('few');
    expect(findings[0]?.detail).toContain('many');
  });

  it('ACCEPTS a four-form message for Polish', () => {
    const report = auditCatalogues({
      sourceLocale: 'en-GB',
      catalogues: {
        'en-GB': { ...enGB },
        pl: plOf(),
      },
    });
    expect(report.findings.filter((f) => f.rule === 'plural-coverage')).toEqual([]);
  });

  it('does NOT demand six forms of an English message, because English has two', () => {
    // The gate must not be so strict that no message can pass. `pluralCategories('en-GB')` is
    // `[one, other]` and `other` is the fallback arm, so nothing is outstanding.
    expect(rulesFor(clean(), 'plural-coverage')).toEqual([]);
  });

  it('treats a message with NO plural as covering nothing, and that is not a finding on its own', () => {
    // `'Saved'` has no plural, so there is no category to be missing. A gate that flagged this would
    // flag every non-count string in the catalogue.
    const report = auditCatalogues({
      sourceLocale: 'en-GB',
      catalogues: { 'en-GB': { ...enGB, 'x.plain': 'Saved' }, pl: plOf({ 'x.plain': 'Zapisano' }) },
    });
    expect(report.findings.filter((f) => f.key === 'x.plain')).toEqual([]);
  });
});

describe('declared-but-absent — a language offered in a picker with no catalogue behind it', () => {
  it('CATCHES a locale `LOCALES` promises and no catalogue serves', () => {
    // The failure with nothing to report it: the student picks Welsh, every string renders in English,
    // and no key is missing because every lookup hits.
    const report = auditCatalogues({
      sourceLocale: SOURCE_LOCALE,
      catalogues: clean(),
      declaredLocales: ['en-GB', 'en-US', 'cy'],
    });
    const findings = report.findings.filter((f) => f.rule === 'declared-but-absent');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.locale).toBe('cy');
    expect(findings[0]?.detail).toContain('source locale');
  });

  it('is quiet when `LOCALES` and the catalogues agree, which is the normal case', () => {
    const report = auditCatalogues({
      sourceLocale: SOURCE_LOCALE,
      catalogues: clean(),
      declaredLocales: ['en-GB', 'en-US'],
    });
    expect(report.ok).toBe(true);
  });

  it('is quiet when `declaredLocales` is omitted, because `scripts/i18n-scan.mjs` also uses this', () => {
    expect(audit(clean()).ok).toBe(true);
  });
});

describe('the two ways a key renders as nothing', () => {
  it('CATCHES a blank value', () => {
    const c = clean();
    c['en-US']['save.state.idle'] = '   ';
    const findings = rulesFor(c, 'empty-value');
    expect(findings[0]?.key).toBe('save.state.idle');
    // A blank value is worse than a missing one: it passes a key-count check and renders nothing.
    expect(rulesFor(c, 'missing-key')).toEqual([]);
  });

  it('CATCHES a value this compiler cannot read, naming the key and the pattern', () => {
    const c = clean();
    c['en-US']['save.state.saved'] = 'Saved {when, timezone}';
    const findings = rulesFor(c, 'unparseable');
    expect(findings[0]?.key).toBe('save.state.saved');
    expect(findings[0]?.detail).toContain('unsupported placeholder type');
    expect(findings[0]?.detail).toContain('timezone');
  });

  it('reports ONE finding per broken key rather than cascading from the parse failure', () => {
    // An unparseable value cannot have its placeholders compared, so reporting a placeholder
    // mismatch as well would be noise about a pattern nobody can read.
    const c = clean();
    c['en-US']['save.failure.detail'] = '{count';
    expect(rulesFor(c, 'placeholder-mismatch')).toEqual([]);
    expect(rulesFor(c, 'unparseable')).toHaveLength(1);
  });
});
