import { describe, expect, it } from 'vitest';
import { exportQtiAssessment, type QtiChoiceQuestion } from './qti.js';
import { importQtiItem } from './qti-import.js';

const binding = { externalId: 'x', localType: 'assessment', localId: 'a1', tenantId: null };

const question = (): QtiChoiceQuestion => ({
  id: 'q1',
  stem: [{ text: 'Which side is longest?' }],
  choices: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]],
  correctChoiceIndex: 2,
  points: 4,
});

function exported(): string {
  return exportQtiAssessment({ title: 't', questions: [question()], itemIds: ['q1'], binding })
    .items[0].xml;
}

describe('QTI import', () => {
  it('round-trips our own export: import(export(q)) rebuilds q', () => {
    const back = importQtiItem(exported());
    expect(back.report.dropped).toEqual([]);
    expect(back.question).toMatchObject({
      id: 'q1',
      stem: [{ text: 'Which side is longest?' }],
      correctChoiceIndex: 2,
      points: 4,
    });
    expect(back.question?.choices.map((choice) => choice[0].text)).toEqual(['a', 'b', 'c']);
  });

  it('round-trips BYTE-IDENTICALLY: export(import(export(q))) === export(q)', () => {
    const first = exported();
    const back = importQtiItem(first);
    expect(back.question).not.toBeNull();
    const second = exportQtiAssessment({
      title: 't',
      questions: [back.question as QtiChoiceQuestion],
      itemIds: ['q1'],
      binding,
    }).items[0].xml;
    // Byte identity is what makes the format a format rather than a write-only dump: any drift here
    // means the exporter and importer disagree about the same document.
    expect(second).toBe(first);
  });

  it('refuses an orderInteraction RATHER than grading sequence as selection', () => {
    const foreign = exported().replace(
      '<choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1">',
      '<orderInteraction responseIdentifier="RESPONSE" shuffle="false">',
    );
    const back = importQtiItem(foreign);
    expect(back.question).toBeNull();
    expect(back.report.dropped[0]?.why).toMatch(/only single-correct choice imports/);
  });

  it('refuses multi-choice rather than awarding marks it cannot compute', () => {
    const foreign = exported().replace('maxChoices="1"', 'maxChoices="2"');
    const back = importQtiItem(foreign);
    expect(back.question).toBeNull();
    expect(back.report.dropped[0]?.why).toMatch(/maxChoices="1"/);
  });

  it('refuses a correctResponse naming no listed choice', () => {
    const foreign = exported().replace('<value>q1-choice-2</value>', '<value>q1-choice-9</value>');
    const back = importQtiItem(foreign);
    expect(back.question).toBeNull();
    expect(back.report.dropped[0]?.why).toMatch(/no listed choice id/);
  });

  it('records the fallback when the mapping has no entry for the correct choice', () => {
    const foreign = exported().replace(
      /<mapEntry mapKey="q1-choice-2" mappedValue="[^"]*"\/>\n?/u,
      '',
    );
    const back = importQtiItem(foreign);
    expect(back.question?.points).toBe(4);
    expect(back.report.approximated.some((a) => a.how.includes('upperBound'))).toBe(true);
  });

  it('records a non-map_response template instead of silently accepting it', () => {
    const foreign = exported().replace('/map_response', '/match_correct');
    const back = importQtiItem(foreign);
    expect(back.question).not.toBeNull();
    expect(back.report.approximated.some((a) => a.how.includes('not map_response'))).toBe(true);
  });

  it('refuses an item with no identifier rather than inventing one', () => {
    const missing = importQtiItem('<assessmentItem xmlns="x"><itemBody/></assessmentItem>');
    expect(missing.question).toBeNull();
    expect(missing.report.dropped[0]?.why).toMatch(/no identifier/);
  });
});
