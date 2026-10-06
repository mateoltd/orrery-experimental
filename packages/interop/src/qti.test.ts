import { describe, expect, it } from 'vitest';
import { exportQtiAssessment, type QtiChoiceQuestion } from './qti.js';

const binding = { externalId: 'x', localType: 'assessment', localId: 'a1', tenantId: null };

const question = (overrides: Partial<QtiChoiceQuestion> = {}): QtiChoiceQuestion => ({
  id: 'q1',
  stem: [{ text: 'Which side is longest?' }],
  choices: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]],
  correctChoiceIndex: 2,
  points: 4,
  ...overrides,
});

/** Well-formedness without an XML library: every opened tag is closed, in order. */
function tagsBalanced(xml: string): boolean {
  const stack: string[] = [];
  for (const match of xml.matchAll(/<\/?([A-Za-z][\w.-]*)(?:\s[^>]*)?\/?>/gu)) {
    const full = match[0];
    const name = match[1];
    if (full.endsWith('/>') || full.startsWith('<?')) continue;
    if (full.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

describe('QTI 2.2 export', () => {
  it('emits a choiceInteraction with the correct response and a mapResponse template', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
    });
    const xml = out.items[0].xml;
    expect(xml).toContain(
      '<choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1">',
    );
    expect(xml).toContain('<correctResponse><value>q1-choice-2</value></correctResponse>');
    expect(xml).toContain(
      'template="http://www.imsglobal.org/question/qti_v2p2/rptemplates/map_response"',
    );
  });

  it('maps the correct choice to full points and every other to zero, bounded above', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
    });
    const xml = out.items[0].xml;
    expect(xml).toContain('<mapEntry mapKey="q1-choice-2" mappedValue="4"/>');
    expect(xml).toContain('<mapEntry mapKey="q1-choice-0" mappedValue="0"/>');
    expect(xml).toContain('<mapping lowerBound="0" upperBound="4" defaultValue="0">');
  });

  it('escapes stems and choices, because an exporter that does not is an injection surface', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question({ stem: [{ text: 'a<b>&"c"' }] })],
      itemIds: ['q1'],
      binding,
    });
    expect(out.items[0].xml).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
  });

  it('drops non-conforming hrefs rather than widening the link schemes', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question({ stem: [{ text: 'x', href: 'javascript:alert(1)' }] })],
      itemIds: ['q1'],
      binding,
    });
    expect(out.items[0].xml).not.toContain('javascript:');
    expect(out.items[0].xml).toContain('>x<');
  });

  it('carries math as a TeX annotation and records the approximation', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question({ stem: [{ text: '', math: '\\frac{1}{2}' }] })],
      itemIds: ['q1'],
      binding,
    });
    expect(out.items[0].xml).toContain(
      '<m:annotation encoding="application/x-tex">\\frac{1}{2}</m:annotation>',
    );
    expect(out.report.approximated.length).toBeGreaterThan(0);
  });

  it('refuses an out-of-range correctChoiceIndex instead of exporting a broken item', () => {
    expect(() =>
      exportQtiAssessment({
        title: 't',
        questions: [question({ correctChoiceIndex: 5 })],
        itemIds: ['q1'],
        binding,
      }),
    ).toThrow(/QTI_ITEM_INVALID/);
  });

  it('refuses the audit gate bypass: empty item ids throw', () => {
    expect(() =>
      exportQtiAssessment({ title: 't', questions: [question()], itemIds: [], binding }),
    ).toThrow(/UNNAMEABLE_EXPORT/);
  });

  it('refuses duplicated item ids, because the audit event would name them once', () => {
    expect(() =>
      exportQtiAssessment({ title: 't', questions: [question()], itemIds: ['q1', 'q1'], binding }),
    ).toThrow(/DUPLICATE_ITEM_IN_EXPORT/);
  });

  it('exports simulations as extendedTextInteraction carrying id+version, per NON_PORTABLE_FEATURES', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question()],
      sims: [{ simId: 'maths.pythagoras', version: '1.0.0' }],
      itemIds: ['q1'],
      binding,
    });
    const sim = out.items.find((item) => item.id === 'sim-maths.pythagoras');
    expect(sim?.xml).toContain('<extendedTextInteraction responseIdentifier="RESPONSE"');
    expect(sim?.xml).toContain('data-sim-id="maths.pythagoras" data-sim-version="1.0.0"');
    expect(
      out.report.approximated.some((a) => a.how.includes('interaction state is not portable')),
    ).toBe(true);
  });

  it('the test references every item and the manifest references every item file', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [question(), { ...question(), id: 'q2' }],
      itemIds: ['q1', 'q2'],
      binding,
    });
    expect(out.testXml).toContain('href="q1.xml"');
    expect(out.testXml).toContain('href="q2.xml"');
    expect(out.manifestXml).toContain('href="q1.xml"');
    expect(out.manifestXml).toContain('href="q2.xml"');
  });

  it('every emitted document is tag-balanced', () => {
    const out = exportQtiAssessment({
      title: 't',
      questions: [
        question({
          stem: [
            { text: 'a', bold: true },
            { text: 'b', href: 'https://x.example' },
          ],
        }),
      ],
      sims: [{ simId: 's', version: '1.0.0' }],
      itemIds: ['q1'],
      binding,
    });
    for (const item of out.items) expect(tagsBalanced(item.xml), item.id).toBe(true);
    expect(tagsBalanced(out.testXml)).toBe(true);
    expect(tagsBalanced(out.manifestXml)).toBe(true);
  });
});

describe('QTI 3.0 (P16-T3)', () => {
  it('swaps the namespace and template URIs and nothing else', () => {
    const v22 = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
    });
    const v30 = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
      version: '3.0',
    });
    expect(v30.items[0].xml).toContain('xmlns="http://www.imsglobal.org/xsd/qti/v3p0"');
    expect(v30.items[0].xml).toContain('/qti_v3p0/rptemplates/map_response');
    expect(v30.items[0].xml).not.toContain('v2p2');
    expect(v30.testXml).toContain('xmlns="http://www.imsglobal.org/xsd/qti/v3p0"');
    // Same document modulo the version URIs: strip them and the outputs are identical, which is what
    // "parameterized, not reimplemented" means.
    const strip = (xml: string): string =>
      xml.replace(/qti\/v3p0|imsqti_v2p2|qti_v3p0|qti_v2p2/gu, 'V');
    expect(strip(v30.items[0].xml)).toBe(strip(v22.items[0].xml));
    expect(strip(v30.testXml)).toBe(strip(v22.testXml));
  });

  it('defaults to 2.2, so existing consumers see byte-identical output', () => {
    const implicit = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
    });
    const explicit = exportQtiAssessment({
      title: 't',
      questions: [question()],
      itemIds: ['q1'],
      binding,
      version: '2.2',
    });
    expect(implicit.items[0].xml).toBe(explicit.items[0].xml);
  });
});
