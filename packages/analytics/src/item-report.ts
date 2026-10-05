import { CAVEATS } from './caveats.js';
import { type Rollup, serve } from './rollups.js';
import { type SuppressibleStat, suppress } from './suppression.js';

export const ITEM_REPORT_PURPOSE =
  'These figures help review questions and pools. They must never rank, compare, or sanction students.';
export const INSUFFICIENT_RESPONSES = '— not enough responses';
export const UNAVAILABLE_STATISTIC = '— not computed or unavailable';

export interface ItemReportMetric {
  readonly name: string;
  readonly stat: SuppressibleStat;
  readonly n: number;
  readonly value: number | null;
  readonly interval: readonly [number, number] | null;
}

export interface ItemReportInput {
  readonly questionId: string;
  readonly formCount: number | null;
  readonly metrics: readonly ItemReportMetric[];
}

/** The export boundary re-applies the pure guard even if a query or cache forgot it. */
export function itemReportCells(rollup: Rollup<ItemReportInput>, now: number): readonly string[] {
  const result = serve(rollup, now);
  const common = [
    rollup.assignmentId,
    String(rollup.computedAt),
    result.freshness.state,
    ITEM_REPORT_PURPOSE,
    CAVEATS.map((c) => c.body).join(' '),
  ];
  if (!result.served) return [...common, '', '', result.reason];
  const row = result.value;
  return [
    ...common,
    row.questionId,
    row.formCount === null ? 'unavailable' : String(row.formCount),
    JSON.stringify(
      row.metrics.map((metric) => {
        const valid =
          Number.isInteger(metric.n) &&
          metric.n >= 0 &&
          metric.value !== null &&
          Number.isFinite(metric.value);
        const interval = metric.interval;
        const validInterval = interval?.every(Number.isFinite) && interval[0] <= interval[1];
        const enoughResponses =
          Number.isInteger(metric.n) &&
          metric.n >= 0 &&
          !suppress(0, metric.stat, metric.n).suppressed;
        const value =
          valid &&
          !suppress(metric.value as number, metric.stat, metric.n).suppressed &&
          (metric.stat === 'facility' || validInterval)
            ? String(metric.value)
            : enoughResponses
              ? UNAVAILABLE_STATISTIC
              : INSUFFICIENT_RESPONSES;
        return {
          name: metric.name,
          n: metric.n,
          value,
          interval: !valid || !enoughResponses || !validInterval ? null : interval,
          intervalLabel: valid && enoughResponses && validInterval ? '95% CI' : null,
        };
      }),
    ),
  ];
}
