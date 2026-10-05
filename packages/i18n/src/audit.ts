/**
 * The completeness audit, as a function — so the gate and the test suite check the SAME rules.
 *
 * ## WHY THE RULES LIVE HERE AND NOT IN `scripts/i18n-check.mjs`
 *
 * Because a gate whose logic exists only inside the gate's script has exactly one caller, and that
 * caller is a process that exits. `auditCatalogues` is a pure function over catalogues;
 * `scripts/i18n-check.mjs` prints what it returns and `src/audit.test.ts` plants a violation of each
 * kind and asserts it is caught. **A gate that is only ever run on clean data has never been shown
 * to fail**, which is the shape this task was written against.
 *
 * ## WHAT IS CHECKED, AND WHY EACH ONE IS WORTH ITS PLACE
 *
 *   · **`missing-key`** — a key the source has and a locale does not. Renders as the key on screen,
 *     which is at least visible. Still a build failure: it is a missing translation, and the fix is
 *     a translator, not a code change.
 *   · **`orphan-key`** — a key a locale has and the source does not. This is the one that makes a
 *     "two catalogues differ" report actionable. If three keys were deleted from `en-GB` and left in
 *     `en-US`, a symmetric check says "en-GB is missing three keys" and the reader opens the wrong
 *     catalogue. Naming the source locale first, and checking orphans against it, is what stops that.
 *   · **`placeholder-mismatch`** — a translation that dropped or misspelled `{count}`. **This is the
 *     one that outranks the key count**, because a missing key degrades one string visibly and a
 *     dropped placeholder prints a literal brace to a student mid-exam: `{count} attempts so far`.
 *   · **`plural-coverage`** — a message whose plural arms do not cover every category its locale can
 *     produce. For `en-GB` that is `one`/`other` and almost every message passes; for `pl` it is
 *     `one`/`few`/`many`/`other` and a two-form message fails. Asked of ICU, never hardcoded.
 *   · **`empty-value`** and **`unparseable`** — a key whose value is blank or is not a message this
 *     compiler can read. Both are "renders nothing" or "throws at render time", which is the crash
 *     this whole task is about.
 */

import { pluralCategories } from './intl.js';
import {
  categoriesCovered,
  hasPlural,
  type MessageNode,
  MessageSyntaxError,
  parseMessage,
  placeholdersIn,
} from './message.js';

export type AuditRule =
  | 'missing-key'
  | 'orphan-key'
  | 'placeholder-mismatch'
  | 'plural-coverage'
  | 'empty-value'
  | 'unparseable'
  | 'declared-but-absent';

export interface AuditFinding {
  readonly rule: AuditRule;
  readonly locale: string;
  /** The catalogue key, always named. "12 missing keys" is not actionable. */
  readonly key: string;
  readonly detail: string;
}

export interface AuditInput {
  /** The tag of the authoritative catalogue. Named on every run, never inferred. */
  readonly sourceLocale: string;
  /** Locale tag -> its catalogue. Must include `sourceLocale`. */
  readonly catalogues: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Every locale a build PROMISES to ship, from `LOCALES`.
   *
   * **`LOCALES` and the catalogue map are two lists and nothing in the type system makes them agree.**
   * The failure when they disagree is the worst kind: the app offers a language in a picker, the
   * student picks it, and every string renders in the source locale instead — no error, no missing
   * key, nothing for this audit to notice unless it is told what was promised.
   */
  readonly declaredLocales?: readonly string[];
}

export interface AuditReport {
  readonly sourceLocale: string;
  /** Every locale the audit looked at, source first. */
  readonly locales: readonly string[];
  readonly keyCount: number;
  readonly findings: readonly AuditFinding[];
  readonly ok: boolean;
}

const EMPTY: Readonly<Record<string, string>> = {};

export function auditCatalogues(input: AuditInput): AuditReport {
  const { sourceLocale, catalogues } = input;
  const source = catalogues[sourceLocale];

  // An audit with no source catalogue cannot compare anything, and reporting "0 missing keys" for it
  // would be the worst possible outcome: a green gate for a gate that checked nothing.
  if (source === undefined) {
    return {
      sourceLocale,
      locales: [],
      keyCount: 0,
      ok: false,
      findings: [
        {
          rule: 'missing-key',
          locale: sourceLocale,
          key: '<source catalogue>',
          detail: `no catalogue for the declared source locale ${JSON.stringify(sourceLocale)}`,
        },
      ],
    };
  }

  const sourceKeys = Object.keys(source).sort();
  const findings: AuditFinding[] = [];
  const locales = [
    sourceLocale,
    ...Object.keys(catalogues)
      .filter((tag) => tag !== sourceLocale)
      .sort(),
  ];

  for (const tag of input.declaredLocales ?? []) {
    if (!Object.hasOwn(catalogues, tag)) {
      findings.push({
        rule: 'declared-but-absent',
        locale: tag,
        key: '<catalogue>',
        detail:
          `LOCALES promises ${JSON.stringify(tag)} but there is no catalogue for it, so choosing that ` +
          'language renders every string in the source locale with nothing to report it',
      });
    }
  }

  for (const locale of locales) {
    const catalogue = catalogues[locale] ?? EMPTY;
    const record = catalogue as Record<string, string | undefined>;

    for (const key of sourceKeys) {
      const value = record[key];
      if (typeof value !== 'string') {
        findings.push({
          rule: 'missing-key',
          locale,
          key,
          detail: `the ${locale} catalogue has no entry for a key the source ${sourceLocale} defines`,
        });
        continue;
      }
      if (value.trim().length === 0) {
        findings.push({
          rule: 'empty-value',
          locale,
          key,
          detail: 'the value is blank, which renders as an empty string rather than as the key',
        });
        continue;
      }

      let nodes: readonly MessageNode[];
      try {
        nodes = parseMessage(value);
      } catch (error) {
        if (error instanceof MessageSyntaxError) {
          findings.push({
            rule: 'unparseable',
            locale,
            key,
            detail: `${error.message}`,
          });
          continue;
        }
        throw error;
      }

      // The placeholder check is against the SOURCE, not against the other locales. Comparing
      // translations to each other only proves they agree, which two identical typos do.
      const wanted = placeholdersIn(parseMessage(source[key] ?? ''));
      const got = placeholdersIn(nodes);
      const missing = [...wanted].filter((name) => !got.has(name)).sort();
      const extra = [...got].filter((name) => !wanted.has(name)).sort();
      if (missing.length > 0 || extra.length > 0) {
        findings.push({
          rule: 'placeholder-mismatch',
          locale,
          key,
          detail:
            `source ${sourceLocale} uses {${[...wanted].sort().join('}, {')}} ` +
            `but ${locale} uses {${[...got].sort().join('}, {')}}` +
            (missing.length > 0 ? ` — dropped: ${missing.map((n) => `{${n}}`).join(', ')}` : '') +
            (extra.length > 0 ? ` — invented: ${extra.map((n) => `{${n}}`).join(', ')}` : ''),
        });
      }

      // Only a message that SELECTS A PLURAL can be short of a category. See `hasPlural`.
      const covered = categoriesCovered(value);
      // `other` is excluded: the parser requires it, so it is always present and listing it as
      // "missing" would make every finding read as though `other` were also outstanding.
      const absent = hasPlural(nodes)
        ? pluralCategories(locale).filter(
            (category) => category !== 'other' && !covered.has(category),
          )
        : [];
      if (absent.length > 0) {
        findings.push({
          rule: 'plural-coverage',
          locale,
          key,
          detail:
            `${locale} can produce ${pluralCategories(locale).join(', ')} and this message covers only ` +
            `${covered.size === 0 ? '(no plural category)' : [...covered].join(', ')} — ` +
            `missing: ${absent.join(', ')}`,
        });
      }
    }

    for (const key of Object.keys(record).sort()) {
      if (!Object.hasOwn(source, key)) {
        findings.push({
          rule: 'orphan-key',
          locale,
          key,
          detail: `present in ${locale} and absent from the source ${sourceLocale}, so no component can ever ask for it`,
        });
      }
    }
  }

  return {
    sourceLocale,
    locales,
    keyCount: sourceKeys.length,
    findings,
    ok: findings.length === 0,
  };
}
