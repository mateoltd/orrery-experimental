import { describe, expect, it } from 'vitest';
import {
  buildLedgerRow,
  completePaperResponses,
  type LedgerAssignment,
  type LedgerAttempt,
  resolvedVariant,
} from './report-gradebook.js';

const assignment = (id = 'a', weight = 1): LedgerAssignment => ({
  id,
  title: id,
  weight,
  dueAt: 10,
  latePenaltyPercent: 10,
  possibleItemCount: 60,
});
const attempt = (assignmentId = 'a', mark = 8): LedgerAttempt => ({
  id: assignmentId,
  assignmentId,
  status: 'GRADED',
  isLate: false,
  submittedAt: 8,
  variantMap: { '0': ['variant-B'] },
  releasedResponses: [
    { questionId: 'variant-B', points: 10, finalScore: mark, needsHuman: false, isExcused: false },
  ],
});
const row = (assignments = [assignment()], attempts = [attempt()]) =>
  buildLedgerRow({ studentId: 's', student: 'Name', assignments, attempts, computedAt: 20 });

describe('P11-T6 gradebook ledger', () => {
  it('derives 65% from 80% at weight 1 and 60% at weight 3', () => {
    const result = row(
      [assignment('a', 1), assignment('b', 3)],
      [attempt('a', 8), attempt('b', 6)],
    );
    expect(result.total).toEqual({
      percentage: 65,
      includedWeight: 4,
      pendingWeight: 0,
      excusedWeight: 0,
      isProvisional: false,
      computedAt: 20,
    });
  });
  it('shows the recorded variant B in numeric slot order, never the shared paper', () => {
    const a = attempt();
    expect(
      row(
        [assignment()],
        [
          {
            ...a,
            variantMap: { '1': ['variant-B'], '0': ['q-first'] },
            releasedResponses: [
              ...(a.releasedResponses ?? []),
              {
                questionId: 'q-first',
                points: 10,
                finalScore: 0,
                isExcused: false,
                needsHuman: false,
              },
            ],
          },
        ],
      ).cells[0]?.variant,
    ).toEqual({
      questionIds: ['q-first', 'variant-B'],
      label: 'Saw 2 of a possible 60-item pool',
    });
  });
  it('withholds a total while a weighted assignment is sealed', () => {
    const result = row(
      [assignment(), assignment('b', 3)],
      [attempt(), { ...attempt('b'), releasedResponses: null }],
    );
    expect(result.cells[1]?.score).toBeNull();
    expect(result.total.percentage).toBeNull();
    expect(result.total.pendingWeight).toBe(3);
  });
  it('does not silently drop missing or void work from a course total', () => {
    const missing = row([assignment(), assignment('b', 3)], [attempt()]);
    expect(missing.cells[1]?.flag).toBe('missing');
    expect(missing.total.percentage).toBeNull();
    const voided = row(
      [assignment(), assignment('b', 3)],
      [attempt(), { ...attempt('b'), status: 'VOIDED' }],
    );
    expect(voided.cells[1]?.flag).toBe('void');
    expect(voided.cells[1]?.score).toBeNull();
    expect(voided.total.pendingWeight).toBe(3);
  });
  it('excused assignment weight leaves both course sums', () => {
    const result = row(
      [assignment(), assignment('b', 3)],
      [attempt(), { ...attempt('b'), status: 'EXCUSED' }],
    );
    expect(result.total.percentage).toBe(80);
    expect(result.total.excusedWeight).toBe(3);
    expect(result.total.includedWeight).toBe(1);
  });
  it('excused responses leave both attempt sums', () => {
    const a = attempt();
    const result = row(
      [assignment()],
      [
        {
          ...a,
          variantMap: { '0': ['variant-B', 'excluded'] },
          releasedResponses: [
            ...(a.releasedResponses ?? []),
            {
              questionId: 'excluded',
              points: 10,
              finalScore: 0,
              isExcused: true,
              needsHuman: false,
            },
          ],
        },
      ],
    );
    expect(result.cells[0]?.score).toMatchObject({ rawTotal: 8, maxTotal: 10, finalScore: 80 });
  });
  it('needs-human retains possible marks but drops a stale mark and flags provisional', () => {
    const a = attempt();
    const result = row(
      [assignment()],
      [
        {
          ...a,
          variantMap: { '0': ['variant-B', 'human'] },
          releasedResponses: [
            ...(a.releasedResponses ?? []),
            { questionId: 'human', points: 10, finalScore: 10, isExcused: false, needsHuman: true },
          ],
        },
      ],
    );
    expect(result.cells[0]?.score).toMatchObject({
      rawTotal: 8,
      maxTotal: 20,
      finalScore: 40,
      isProvisional: true,
    });
    expect(result.total.percentage).toBeNull();
  });
  it.each([-10, 200])('clamps late penalty %s through the shared arithmetic', (penalty) => {
    const result = row(
      [{ ...assignment(), latePenaltyPercent: penalty }],
      [{ ...attempt(), isLate: true }],
    );
    expect(result.cells[0]?.flag).toBe('late');
    expect(result.cells[0]?.score?.finalScore).toBe(penalty < 0 ? 80 : 0);
  });
  it('zero maximum and all-excused papers are unavailable, never zero percent', () => {
    const result = row(
      [assignment()],
      [
        {
          ...attempt(),
          releasedResponses: [
            {
              questionId: 'variant-B',
              points: 0,
              finalScore: 0,
              isExcused: false,
              needsHuman: false,
            },
          ],
        },
      ],
    );
    expect(result.cells[0]?.score?.percentage).toBeNull();
    expect(result.total.percentage).toBeNull();
  });
  it('zero-weight missing work cannot block a total', () => {
    expect(row([assignment(), assignment('b', 0)], [attempt()]).total.percentage).toBe(80);
    expect(row([], []).total.percentage).toBeNull();
  });
  it('records pending work before its due time without calling it missing', () => {
    const result = row([{ ...assignment(), dueAt: null }], []);
    expect(result.cells[0]).toMatchObject({ flag: 'pending', state: 'NO_ATTEMPT', computedAt: 20 });
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid weight %s', (weight) => {
    expect(() => row([assignment('a', weight)])).toThrow('weight');
  });
  it.each([null, [], {}, { x: ['q'] }, { '0': 'q' }, { '0': [1] }])(
    'absent or malformed variants are disclosed (%j)',
    (map) => {
      expect(resolvedVariant(map, 60).label).toBe('Resolved variant unavailable');
    },
  );
  it('does not invent a pool size or form-equating figures', () => {
    expect(resolvedVariant({ '0': ['q'] }, null).label).toContain('pool size unavailable');
    expect(row().cells[0]).toMatchObject({ formMean: null, formVariabilitySd: null });
  });
  it('a missing resolved response cannot inflate a percentage when its maximum is unknown', () => {
    const result = row(
      [assignment()],
      [{ ...attempt(), variantMap: { '0': ['variant-B', 'missing-response'] } }],
    );
    expect(result.cells[0]?.score).toBeNull();
    expect(result.total.percentage).toBeNull();
  });
  it('unanswered resolved questions count toward the maximum: 8/20, never 8/10', () => {
    const map = { '0': ['variant-B', 'unanswered'] };
    const responses = completePaperResponses(
      map,
      attempt().releasedResponses ?? [],
      new Map([['unanswered', 10]]),
    );
    const result = row(
      [assignment()],
      [{ ...attempt(), variantMap: map, releasedResponses: responses }],
    );
    expect(result.cells[0]?.score).toMatchObject({ rawTotal: 8, maxTotal: 20, finalScore: 40 });
  });
  it('a zero-point question remains a complete recorded paper', () => {
    const map = { '0': ['variant-B', 'zero'] };
    const responses = completePaperResponses(
      map,
      attempt().releasedResponses ?? [],
      new Map([['zero', 0]]),
    );
    expect(
      row([assignment()], [{ ...attempt(), variantMap: map, releasedResponses: responses }])
        .cells[0]?.score?.finalScore,
    ).toBe(80);
  });
  it.each([undefined, Number.NaN, -1])(
    'refuses to invent an unavailable question maximum (%s)',
    (maximum) => {
      const map = { '0': ['variant-B', 'unanswered'] };
      const points =
        maximum === undefined ? new Map<string, number>() : new Map([['unanswered', maximum]]);
      const responses = completePaperResponses(map, attempt().releasedResponses ?? [], points);
      expect(
        row([assignment()], [{ ...attempt(), variantMap: map, releasedResponses: responses }])
          .cells[0]?.score,
      ).toBeNull();
    },
  );
  it.each([{ '0': ['variant-B', 'variant-B'] }, { '0': ['unexpected'] }, {}])(
    'refuses a duplicate or inconsistent paper (%j)',
    (map) => {
      expect(row([assignment()], [{ ...attempt(), variantMap: map }]).cells[0]?.score).toBeNull();
    },
  );
});
