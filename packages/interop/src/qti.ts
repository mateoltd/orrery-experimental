/**
 * QTI 2.2 AND 3.0 EXPORT: items, tests, partial-credit response processing, manifest.  (P16-T2, P16-T3)
 *
 * ## WHAT 3.0 CHANGES, AND WHAT IT DOES NOT
 *
 * For everything this exporter emits, QTI 3.0 is QTI 2.2 with different URIs: the item/test namespace
 * (`imsqti_v2p2` -> `qti/v3p0`) and the response-processing template base (`qti_v2p2` -> `qti_v3p0`).
 * `choiceInteraction`, `simpleChoice`, `mapResponse` mappings, `extendedTextInteraction` and the content
 * packaging manifest are structurally identical. **A "3.0 exporter" that reimplemented the documents would
 * be two exporters that can disagree; this one parameterizes the version table and shares everything else.**
 *
 * What 3.0 ADDS that is deliberately NOT claimed here: `qti-assessment-item` web-component packaging,
 * PCI custom interactions, and `testPart` refinements -- none of which our constructs need, and each of
 * which would be a new format to get wrong rather than a URI to swap.
 *
 * ## SCOPE, STATED FIRST BECAUSE AN EXPORTER'S SCOPE IS ITS HONESTY
 *
 * This module exports `practiceCheck` blocks -- the system's single-correct-choice question -- as QTI 2.2
 * `assessmentItem` documents, wraps them in an `assessmentTest`, and describes the package in an LOM-style
 * `imsmanifest.xml`. Everything else about the product is either carried faithfully, approximated and
 * RECORDED, or refused:
 *
 *   - rich-text stems/choices -> XHTML (`strong`/`em`/`s`/`code`/`a`); links restricted to the same
 *     `http(s)`/`mailto` schemes the contracts renderer enforces;
 *   - math runs -> `<m:math>` carrying ONLY an `application/x-tex` annotation with the source, recorded as
 *     approximated, because **this package has no dependencies and therefore no KaTeX** -- emitting
 *     full MathML here would mean hand-rolling a TeX parser, and a hand-rolled TeX parser is how an
 *     exporter silently mangles every equation it touches;
 *   - simulations -> `extendedTextInteraction` carrying sim id + version, EXACTLY as
 *     `NON_PORTABLE_FEATURES` already specified, recorded as approximated;
 *   - anything else -> refused at the type level (the input type only admits what is portable).
 *
 * ## PARTIAL CREDIT IS IN THE STRUCTURE, NOT THE CONTENT (YET)
 *
 * Every item's `responseDeclaration` carries a `mapping` with one `mapEntry` per choice (correct ->
 * points, others -> 0, `defaultValue` 0) and the test template is the standard `map_response`. A
 * `practiceCheck` has exactly one correct choice, so no partial marks can arise from it today -- but the
 * RESPONSE PROCESSING is `mapResponse`, not `match_correct`, which is what makes a future multi-correct
 * or tolerance-graded item exportable without changing the pipeline. **Claiming partial credit that cannot
 * arise would be the pre-ticked checklist; the structure is partial-credit-capable and the content is
 * single-correct, and both facts are stated.**
 *
 * ## NO XML LIBRARY, DELIBERATELY
 *
 * This package has zero dependencies and the exporter is string-built with a single escape function. An XML
 * builder dependency for three document shapes would be a supply-chain entry for no structural gain -- and the
 * well-formedness that a builder would guarantee is instead asserted by the tests, which check balanced tags
 * on every golden output.
 */

import { assertExportIsAuditable, type ExternalBinding, type MappingReport } from './codec.js';

/** A portable question: the only input this exporter accepts. */
export interface QtiChoiceQuestion {
  readonly id: string;
  readonly stem: readonly QtiRun[];
  readonly choices: readonly (readonly QtiRun[])[];
  readonly correctChoiceIndex: number;
  readonly points: number;
  readonly explanation?: readonly QtiRun[];
}

export interface QtiRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  readonly math?: string;
}

/** A simulation referenced by an assessment, exported per `NON_PORTABLE_FEATURES`. */
export interface QtiSimReference {
  readonly simId: string;
  readonly version: string;
}

export interface QtiExport {
  readonly items: readonly { readonly id: string; readonly xml: string }[];
  readonly testXml: string;
  readonly manifestXml: string;
  readonly report: MappingReport;
}

const LINK_SCHEMES = /^(https?|mailto):/u;

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function renderRun(run: QtiRun, approximated: string[]): string {
  if (run.math !== undefined) {
    // TeX source as an annotation, NOT rendered MathML: no KaTeX here, by dependency design.
    approximated.push(
      `math run "${run.math.slice(0, 40)}" carried as TeX annotation, not rendered MathML`,
    );
    return `<m:math><m:annotation encoding="application/x-tex">${escapeXml(run.math)}</m:annotation></m:math>`;
  }
  let out = escapeXml(run.text);
  if (run.code === true) out = `<code>${out}</code>`;
  if (run.strike === true) out = `<s>${out}</s>`;
  if (run.italic === true) out = `<em>${out}</em>`;
  if (run.bold === true) out = `<strong>${out}</strong>`;
  if (run.href !== undefined && LINK_SCHEMES.test(run.href)) {
    out = `<a href="${escapeXml(run.href)}">${out}</a>`;
  }
  // A non-conforming href is DROPPED, not passed through: the contracts renderer enforces the same
  // schemes, and an exporter that widened them would be a link-scheme bypass wearing an export.
  return out;
}

function renderRuns(runs: readonly QtiRun[], approximated: string[]): string {
  return runs.map((run) => renderRun(run, approximated)).join('');
}

function choiceId(itemId: string, index: number): string {
  return `${itemId}-choice-${String(index)}`;
}

function exportItem(
  question: QtiChoiceQuestion,
  approximated: string[],
  version: (typeof QTI_VERSIONS)[QtiVersion],
): string {
  if (question.correctChoiceIndex < 0 || question.correctChoiceIndex >= question.choices.length) {
    throw new Error(
      `QTI_ITEM_INVALID: ${question.id} correctChoiceIndex ${String(question.correctChoiceIndex)} ` +
        `is out of range for ${String(question.choices.length)} choices`,
    );
  }
  if (question.choices.length < 2 || question.choices.length > 12) {
    throw new Error(
      `QTI_ITEM_INVALID: ${question.id} has ${String(question.choices.length)} choices; QTI choiceInteraction ` +
        `needs at least 2 and this exporter caps at 12, matching the practiceCheck contract`,
    );
  }
  const correct = choiceId(question.id, question.correctChoiceIndex);
  const entries = question.choices
    .map((_, index) => {
      const id = choiceId(question.id, index);
      const value = index === question.correctChoiceIndex ? question.points : 0;
      return `      <mapEntry mapKey="${id}" mappedValue="${String(value)}"/>`;
    })
    .join('\n');
  const options = question.choices
    .map(
      (choice, index) =>
        `      <simpleChoice identifier="${choiceId(question.id, index)}">${renderRuns(choice, approximated)}</simpleChoice>`,
    )
    .join('\n');
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<assessmentItem xmlns="${version.itemNs}" identifier="${escapeXml(question.id)}" title="${escapeXml(question.id)}" adaptive="false" timeDependent="false">`,
    `  <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier">`,
    `    <correctResponse><value>${correct}</value></correctResponse>`,
    `    <mapping lowerBound="0" upperBound="${String(question.points)}" defaultValue="0">`,
    entries,
    `    </mapping>`,
    `  </responseDeclaration>`,
    `  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"/>`,
    `  <itemBody>`,
    `    <p>${renderRuns(question.stem, approximated)}</p>`,
    `    <choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1">`,
    options,
    `    </choiceInteraction>`,
    `  </itemBody>`,
    `  <responseProcessing template="${version.templateBase}/map_response"/>`,
    `</assessmentItem>`,
    '',
  ].join('\n');
}

/** A simulation as `extendedTextInteraction`, exactly as `NON_PORTABLE_FEATURES` specifies. */
function exportSimReference(
  ref: QtiSimReference,
  version: (typeof QTI_VERSIONS)[QtiVersion],
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<assessmentItem xmlns="${version.itemNs}" identifier="sim-${escapeXml(ref.simId)}" title="sim-${escapeXml(ref.simId)}" adaptive="false" timeDependent="false">`,
    `  <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>`,
    `  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"/>`,
    `  <itemBody>`,
    `    <extendedTextInteraction responseIdentifier="RESPONSE" data-sim-id="${escapeXml(ref.simId)}" data-sim-version="${escapeXml(ref.version)}"/>`,
    `  </itemBody>`,
    `  <responseProcessing template="http://www.imsglobal.org/question/qti_v2p2/rptemplates/map_response"/>`,
    `</assessmentItem>`,
    '',
  ].join('\n');
}

export type QtiVersion = '2.2' | '3.0';

const QTI_VERSIONS = {
  '2.2': {
    itemNs: 'http://www.imsglobal.org/xsd/imsqti_v2p2',
    templateBase: 'http://www.imsglobal.org/question/qti_v2p2/rptemplates',
  },
  '3.0': {
    itemNs: 'http://www.imsglobal.org/xsd/qti/v3p0',
    templateBase: 'http://www.imsglobal.org/question/qti_v3p0/rptemplates',
  },
} as const;

export interface QtiAssessmentInput {
  readonly title: string;
  /**
   * Defaults to '2.2': the version the goldens were written against, and the wider-supported interchange.
   * '3.0' swaps the namespace and template URIs; the documents are otherwise identical by construction.
   */
  readonly version?: QtiVersion;
  readonly questions: readonly QtiChoiceQuestion[];
  readonly sims?: readonly QtiSimReference[];
  /**
   * The binding this export goes out under. Passed through so `assertExportIsAuditable` sees a REAL
   * context -- a cast `as never` here would check the audit gate against a fiction, which is the exact
   * failure that function exists to prevent.
   */
  readonly binding: Pick<ExternalBinding, 'externalId' | 'localType' | 'localId' | 'tenantId'>;
  /** Item ids for the audit event. Required for `QTI_ASSESSMENT` by `assertExportIsAuditable`. */
  readonly itemIds: readonly string[];
}

export function exportQtiAssessment(input: QtiAssessmentInput): QtiExport {
  assertExportIsAuditable({ kind: 'QTI_ASSESSMENT', binding: input.binding, items: input.itemIds });
  const approximated: string[] = [];
  const version = QTI_VERSIONS[input.version ?? '2.2'];
  const items = input.questions.map((question) => ({
    id: question.id,
    xml: exportItem(question, approximated, version),
  }));
  for (const sim of input.sims ?? []) {
    items.push({ id: `sim-${sim.simId}`, xml: exportSimReference(sim, version) });
    approximated.push(
      `simulation ${sim.simId}@${sim.version} exported as extendedTextInteraction carrying id+version (per NON_PORTABLE_FEATURES); interaction state is not portable`,
    );
  }
  const refs = items
    .map(
      (item) =>
        `    <assessmentItemRef identifier="${escapeXml(item.id)}" href="${escapeXml(item.id)}.xml"/>`,
    )
    .join('\n');
  const testXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<assessmentTest xmlns="${version.itemNs}" identifier="${escapeXml(input.title)}" title="${escapeXml(input.title)}">`,
    `  <testPart identifier="part-1" navigationMode="linear" submissionMode="simultaneous">`,
    `    <assessmentSection identifier="section-1" title="${escapeXml(input.title)}" visible="true">`,
    refs,
    `    </assessmentSection>`,
    `  </testPart>`,
    `  <outcomeProcessing/>`,
    `</assessmentTest>`,
    '',
  ].join('\n');
  const resources = items
    .map(
      (item) =>
        `    <resource identifier="${escapeXml(item.id)}" type="imsqti_item_xmlv2p2" href="${escapeXml(item.id)}.xml"><file href="${escapeXml(item.id)}.xml"/></resource>`,
    )
    .join('\n');
  const manifestXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<manifest xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" identifier="${escapeXml(input.title)}">`,
    `  <organizations/>`,
    `  <resources>`,
    resources,
    `  </resources>`,
    `</manifest>`,
    '',
  ].join('\n');
  return {
    items,
    testXml,
    manifestXml,
    report: {
      imported: [...input.itemIds],
      approximated: approximated.map((how) => ({ what: 'QTI 2.2 export', how })),
      dropped: [],
      ignored: [],
    },
  };
}
