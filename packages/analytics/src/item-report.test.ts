import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_RESPONSES,
  type ItemReportInput,
  type ItemReportMetric,
  itemReportCells,
  UNAVAILABLE_STATISTIC,
} from './item-report.js';
import type { Rollup } from './rollups.js';

const metric = (patch: Partial<ItemReportMetric> = {}): ItemReportMetric => ({
  name: 'facility',
  stat: 'facility',
  n: 5,
  value: 0.8,
  interval: null,
  ...patch,
});
const rollup = (metrics = [metric()]): Rollup<ItemReportInput> => ({
  assignmentId: 'a',
  computedAt: 10,
  invalidatedBy: [],
  isRecomputing: false,
  value: { questionId: 'q', formCount: 2, metrics },
});
const statistics = (m: ItemReportMetric) =>
  JSON.parse(itemReportCells(rollup([m]), 20)[7] ?? '[]') as {
    value: string;
    interval: [number, number] | null;
  }[];

describe('P11-T10 item analysis export boundary', () => {
  it('shows facility only at N >= 5, without losing caveats or instrument framing', () => {
    expect(statistics(metric())[0]?.value).toBe('0.8');
    expect(statistics(metric({ n: 4 }))[0]).toEqual(
      expect.objectContaining({ value: INSUFFICIENT_RESPONSES, interval: null }),
    );
    expect(itemReportCells(rollup(), 20).join(' ')).toContain(
      'never rank, compare, or sanction students',
    );
    expect(itemReportCells(rollup(), 20).join(' ')).toContain('Below the minimum number');
  });
  it('keeps correlations hidden below 100 even if a query supplied them with intervals', () => {
    const m = metric({ stat: 'correlation', n: 99, interval: [0.4, 0.9] });
    expect(statistics(m)[0]).toMatchObject({ value: INSUFFICIENT_RESPONSES, interval: null });
    expect(statistics({ ...m, n: 100 })[0]).toMatchObject({ value: '0.8', interval: [0.4, 0.9] });
  });
  it.each([null, [0.9, 0.4], [Number.NaN, 1]])(
    'refuses a correlation with an unusable interval (%j)',
    (interval) => {
      expect(
        statistics(
          metric({ stat: 'correlation', n: 100, interval: interval as [number, number] | null }),
        )[0]?.value,
      ).toBe(UNAVAILABLE_STATISTIC);
    },
  );
  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('refuses unusable values (%s)', (value) => {
    expect(statistics(metric({ value }))[0]?.value).toBe(UNAVAILABLE_STATISTIC);
  });
  it.each([Number.NaN, -1, 4.5])('refuses invalid actual N (%s)', (n) => {
    expect(statistics(metric({ n }))[0]?.value).toBe(INSUFFICIENT_RESPONSES);
  });
  it('does not serve old item figures after regrade', () => {
    const input = {
      ...rollup(),
      isRecomputing: true,
      invalidatedBy: [{ reason: 'REGRADE' as const, at: 15, actor: 't' }],
    };
    const output = itemReportCells(input, 20);
    expect(output).toContain('RECOMPUTING');
    expect(output.join(' ')).not.toContain('0.8');
  });
  it('discloses uncomputed and stale reports with their timestamps', () => {
    expect(itemReportCells({ ...rollup(), value: null }, 20)[7]).toBe('NOT_COMPUTED');
    expect(
      itemReportCells(
        { ...rollup(), invalidatedBy: [{ reason: 'NEW_RESPONSES', at: 15, actor: null }] },
        20,
      ).slice(1, 3),
    ).toEqual(['10', 'STALE']);
  });
  it('preserves input metric order and declares actual form count', () => {
    const output = itemReportCells(
      rollup([metric({ name: 'second', value: 0.2 }), metric({ name: 'first', value: 0.9 })]),
      20,
    );
    expect(output[6]).toBe('2');
    expect(JSON.parse(output[7] ?? '[]').map((m: { name: string }) => m.name)).toEqual([
      'second',
      'first',
    ]);
  });
  it('declares an unavailable form count instead of implying zero forms', () => {
    const input = rollup();
    expect(
      itemReportCells(
        { ...input, value: { questionId: 'q', formCount: null, metrics: [] } },
        20,
      )[6],
    ).toBe('unavailable');
  });
});
