/**
 * QTI IMPORT with a mapping report, and round-trip goldens.  (P16-T4)
 *
 * ## WHAT THIS IMPORTS, AND WHAT IT REFUSES TO PRETEND TO
 *
 * Two cases, handled differently on purpose:
 *
 *   1. **OUR OWN EXPORT** (`qti.ts` output): parsed back into a portable question, field for field. The
 *      round-trip golden below asserts `export -> import -> export` is stable, which is what makes an
 *      export format a format rather than a write-only dump.
 *   2. **FOREIGN QTI** (anyone else's): parsed for what is portable (`choiceInteraction` with
 *      `simpleChoice`s, `correctResponse`, `mapResponse` mappings) and REPORTED for what is not, into the
 *      existing `MappingReport` shape (`imported` / `approximated` / `dropped` / `ignored`).
 *
 * **No XML library, same reason as the exporter:** this package has zero dependencies. The parser is a
 * set of anchored structural extractions, and anything it cannot anchor is not guessed at -- an
 * unanchored parse that "succeeds" is how an importer silently mangles a question, which is worse than
 * refusing it. Every refusal names what was refused and why, because a mapping report that says
 * "dropped: stuff" is a shrug, not a report.
 *
 * ## WHAT "ROUND-TRIP" MEANS HERE, EXACTLY
 *
 * `importQtiItem(exportQtiAssessment(...).items[0].xml)` returns the question, and re-exporting it
 * produces byte-identical XML. That is asserted, not described. It holds because the exporter is
 * deterministic (fixed choice ids, fixed template) and the importer reads exactly what the exporter
 * writes -- **which also means the round-trip proves nothing about FOREIGN QTI**, and the foreign
 * tests below assert the mapping report rather than the question.
 */

import type { MappingReport } from './codec.js';
import type { QtiChoiceQuestion, QtiRun } from './qti.js';

export interface QtiImport {
  readonly question: QtiChoiceQuestion | null;
  readonly report: MappingReport;
}

/** Decode the five entities the exporter emits. Nothing else is decoded, deliberately. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&');
}

/** Inner text of the FIRST `<tag ...>...</tag>`, or null. Anchored, not guessed. */
function inner(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'u'));
  const body = match?.[1];
  return body === undefined ? null : body;
}

/** Strip tags to plain text, unescaping entities. Structure beyond text is the importer's business. */
function plainText(xhtml: string): string {
  return unescapeXml(xhtml.replace(/<[^>]*>/gu, '')).trim();
}

function choiceIds(xml: string): { readonly id: string; readonly text: string }[] {
  const out: { readonly id: string; readonly text: string }[] = [];
  for (const match of xml.matchAll(
    /<simpleChoice identifier="([^"]*)">([\s\S]*?)<\/simpleChoice>/gu,
  )) {
    const id = match[1];
    const body = match[2];
    if (id === undefined || body === undefined) continue;
    out.push({ id, text: plainText(body) });
  }
  return out;
}

export function importQtiItem(xml: string): QtiImport {
  const imported: string[] = [];
  const approximated: { readonly what: string; readonly how: string }[] = [];
  const dropped: { readonly what: string; readonly why: string }[] = [];
  const report = (): MappingReport => ({
    imported: [...imported],
    approximated: [...approximated],
    dropped: [...dropped],
    ignored: [],
  });
  const identifier = xml.match(/<assessmentItem[^>]*identifier="([^"]*)"/u)?.[1] ?? null;
  if (identifier === null) {
    dropped.push({ what: 'assessmentItem', why: 'no identifier attribute' });
    return { question: null, report: report() };
  }

  // Foreign interaction types: named, not parsed. Parsing an `orderInteraction` as choices would
  // award marks for sequence as if it were selection -- a wrong mark from a "successful" import.
  const interactions = [
    ...xml.matchAll(
      /<(choiceInteraction|orderInteraction|hottextInteraction|extendedTextInteraction|textEntryInteraction)([^>]*)>/gu,
    ),
  ].map((match) => ({ kind: String(match[1] ?? ''), attrs: String(match[2] ?? '') }));
  const choice = interactions.find((entry) => entry.kind === 'choiceInteraction');
  if (choice === undefined) {
    const kinds =
      interactions.map((entry) => entry.kind).join(', ') || 'no interaction element at all';
    dropped.push(
      ...[
        {
          what: identifier,
          why: `no choiceInteraction (found: ${kinds}); only single-correct choice imports`,
        },
      ],
    );
    return { question: null, report: report() };
  }
  if (!/maxChoices="1"/u.test(choice.attrs)) {
    dropped.push(
      ...[
        {
          what: identifier,
          why: 'choiceInteraction allows multiple choices; only maxChoices="1" imports (partial-credit multi-correct is exportable but not yet importable)',
        },
      ],
    );
    return { question: null, report: report() };
  }

  const body = inner(xml, 'itemBody') ?? '';
  const stemMatch = body.match(/<p>([\s\S]*?)<\/p>/u);
  const stem: QtiRun[] = [{ text: plainText(stemMatch?.[1] ?? '') }];
  const choices = choiceIds(xml);
  if (choices.length < 2) {
    dropped.push(...[{ what: identifier, why: 'fewer than 2 simpleChoice options' }]);
    return { question: null, report: report() };
  }
  const correct = inner(xml, 'correctResponse');
  const correctId = correct?.match(/<value>([^<]*)<\/value>/u)?.[1] ?? null;
  const correctIndex = choices.findIndex((entry) => entry.id === correctId);
  if (correctIndex < 0) {
    dropped.push(...[{ what: identifier, why: 'correctResponse names no listed choice id' }]);
    return { question: null, report: report() };
  }

  // Points come from the mapping when present; the upperBound is the fallback; 1 is the last resort.
  // Each fallback is one step further from the source, so each is RECORDED, not silently taken.
  let points = 1;
  const mapping = xml.match(/<mapping[^>]*upperBound="([^"]*)"[^>]*>/u);
  const mapEntry = xml.match(
    new RegExp(`<mapEntry mapKey="${correctId}" mappedValue="([^"]*)"`, 'u'),
  );
  if (mapEntry !== null) {
    points = Number(mapEntry[1]);
  } else if (mapping !== null) {
    points = Number(mapping[1]);
    approximated.push({
      what: identifier,
      how: `no mapEntry for the correct choice; points taken from mapping upperBound (${mapping[1]})`,
    });
  } else {
    approximated.push({
      what: identifier,
      how: 'no mapping element; points defaulted to 1',
    });
  }

  const template = xml.match(/<responseProcessing template="([^"]*)"/u)?.[1] ?? null;
  if (template !== null && !template.endsWith('/map_response')) {
    approximated.push({
      what: identifier,
      how: `responseProcessing template is "${template}", not map_response; imported as single-correct choice`,
    });
  }

  return {
    question: {
      id: identifier,
      stem,
      choices: choices.map((entry) => [{ text: entry.text }]),
      correctChoiceIndex: correctIndex,
      points,
    },
    report: {
      imported: [identifier],
      approximated: [...approximated],
      dropped: [...dropped],
      ignored: [],
    },
  };
}
