/**
 * Time on item.  (P11-T1)
 *
 * ## THE MEDIAN AND THE IQR, AGAINST BOTH REFERENCES, AND NEVER THE MEAN
 *
 * `plans/08` §2.4 asks for "median and interquartile range per question, versus the author's `estimatedSeconds` **and**
 * versus the class median". Two references, because they answer different questions: the author's estimate says whether
 * the item was written to be answerable in that time, and the class median says whether THIS class found it slow, which
 * is a statement about the class rather than the item.
 *
 * Median rather than mean because the distribution has a hard right tail: a student who walked away for ten minutes
 * contributes 600 seconds to a mean and nothing to a median, and the mean is then a statement about the walkaways.
 */

export interface TimeOnItem {
  readonly questionId: string;
  /** `null` when no response recorded a duration. Never 0: 0 means instantaneous, which is a different claim. */
  readonly medianMs: number | null;
  readonly q1Ms: number | null;
  readonly q3Ms: number | null;
  readonly n: number;
  /** The author's estimate, so a reader can see both without leaving the page. */
  readonly estimatedSeconds: number | null;
  /** The class median across all items, for the "slow relative to this class" reading. */
  readonly classMedianMs: number | null;
  readonly againstAuthor: string;
  readonly againstClass: string;
}

/**
 * THE MEDIAN, and the lower median for an even count.
 *
 * The lower median is chosen over the mean of the two middle values because it is always an OBSERVED value, so the
 * number a teacher is shown is a duration somebody actually spent.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return sorted[middle - 1] ?? null;
}

/** A QUANTILE BY THE NEAREST-RANK method, so it is always an observed value. */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface TimeInput {
  readonly questionId: string;
  /** Durations in ms. A negative or non-finite duration is discarded, not clamped. */
  readonly durationsMs: readonly number[];
  readonly estimatedSeconds?: number | null;
}

export function timeOnItem(inputs: readonly TimeInput[]): readonly TimeOnItem[] {
  const perItem = inputs.map((input) => {
    const usable = input.durationsMs
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    return {
      questionId: input.questionId,
      medianMs: median(usable),
      q1Ms: quantile(usable, 0.25),
      q3Ms: quantile(usable, 0.75),
      n: usable.length,
      estimatedSeconds: input.estimatedSeconds ?? null,
      durations: usable,
    };
  });

  const allDurations = perItem.flatMap((item) => item.durations);
  const classMedianMs = median(allDurations);

  return perItem.map((item) => {
    const estimatedMs = item.estimatedSeconds === null ? null : item.estimatedSeconds * 1000;

    return {
      questionId: item.questionId,
      medianMs: item.medianMs,
      q1Ms: item.q1Ms,
      q3Ms: item.q3Ms,
      n: item.n,
      estimatedSeconds: item.estimatedSeconds,
      classMedianMs,
      againstAuthor:
        item.medianMs === null
          ? 'no timings recorded'
          : estimatedMs === null
            ? 'no author estimate to compare against'
            : item.medianMs > estimatedMs * 2
              ? `students took more than twice the author's ${String(item.estimatedSeconds)}s estimate`
              : item.medianMs < estimatedMs * 0.5
                ? `students took less than half the author's ${String(item.estimatedSeconds)}s estimate`
                : 'consistent with the author estimate',
      againstClass:
        item.medianMs === null || classMedianMs === null || item.medianMs === classMedianMs
          ? 'no comparison available'
          : item.medianMs > classMedianMs
            ? 'slower than this class median'
            : 'quicker than this class median',
    };
  });
}
