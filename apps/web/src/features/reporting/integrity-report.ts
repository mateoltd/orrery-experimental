import {
  buildTimeline,
  type IntegrityVerdict,
  recordVerdict,
  summariseCounts,
  type TimelineFacts,
  type TimelineReport,
} from '../exam/integrity/timeline.js';

export interface RecordedReportVerdict extends IntegrityVerdict {
  readonly consideredAccessibilityContext: boolean;
}

export interface IntegrityReport extends TimelineReport {
  readonly computedAt: number;
  readonly counts: readonly string[];
  readonly verdict: RecordedReportVerdict | null;
  readonly verdictNotice: string;
  readonly similarityNotice: string;
  readonly sourceNotices: readonly string[];
}

/** This adapter displays a recorded human decision; it has no evidence-to-verdict path. */
export function buildIntegrityReport(input: {
  readonly facts: TimelineFacts;
  readonly verdict: RecordedReportVerdict | null;
  readonly similarityAvailable: boolean;
  readonly computedAt: number;
  readonly sourceNotices?: readonly string[];
}): IntegrityReport {
  const timeline = buildTimeline(input.facts);
  const recorded = input.verdict;
  const accepted =
    recorded === null
      ? null
      : recordVerdict({
          ...recorded,
          // `frozenAt` survives a transition to `VOIDED`; a verdict alone proves no earlier freeze.
          attemptIsFrozen: input.facts.isFrozen,
        });
  const accessibilityMissing =
    recorded !== null &&
    input.facts.similarityClusters.length > 0 &&
    !recorded.consideredAccessibilityContext;
  const verdict = accepted?.ok && !accessibilityMissing ? recorded : null;
  return {
    ...timeline,
    computedAt: input.computedAt,
    counts: summariseCounts(timeline.entries),
    verdict,
    sourceNotices: input.sourceNotices ?? [],
    verdictNotice: accessibilityMissing
      ? 'The recorded decision requires review: similarity context includes dictation, speech-to-text, translation, shared model answers, and group assignments.'
      : recorded !== null && !accepted?.ok
        ? 'The recorded decision is incomplete; a human author and reason are required.'
        : verdict === null
          ? 'No teacher verdict has been recorded.'
          : 'Recorded human decision; evidence does not determine it.',
    similarityNotice: input.similarityAvailable
      ? 'Similar responses can reflect a shared model answer, a group assignment, dictation, speech-to-text, or translation. Cluster membership is not evidence of misconduct. Consider accessibility context before recording a decision.'
      : 'Similarity analysis is unavailable; this does not establish that responses differed. Shared model answers, group assignments, dictation, speech-to-text, and translation can explain similar responses.',
  };
}

export function* integrityLines(report: IntegrityReport): Generator<string> {
  yield `Integrity report: ${report.attemptId}`;
  yield report.banner;
  yield `RN-01: ${report.help}`;
  yield `Computed at: ${new Date(report.computedAt).toISOString()}`;
  yield report.similarityNotice;
  yield 'Non-ASCII characters in this PDF are preserved as Unicode code-point escapes.';
  for (const notice of report.sourceNotices) yield notice;
  yield `Events lost to telemetry shedding: ${report.droppedEventCount}`;
  for (const missing of report.missingForDecision) yield `Missing for review: ${missing}`;
  for (const [key, value] of Object.entries(report.preflight))
    yield `Preflight ${key}: ${String(value)}`;
  for (const count of report.counts) yield count;
  for (const e of report.entries) {
    yield `${new Date(e.at).toISOString()} ${e.severity}: ${e.phrase}`;
    if (e.crossedThreshold !== undefined)
      yield `Threshold crossed: ${e.crossedThreshold}; dropped events: ${e.droppedEventCount ?? 0}`;
  }
  for (const exit of report.forceExits)
    yield `Force-exit report: ${new Date(exit.at).toISOString()} ${exit.phase}`;
  for (const cluster of report.similarityClusters)
    yield `Similarity cluster ${cluster.id}: response IDs ${cluster.responseIds.join(', ')}`;
  yield report.verdictNotice;
  if (report.verdict !== null) {
    yield `Teacher verdict: ${report.verdict.conclusion}`;
    yield `Reason: ${report.verdict.reason}`;
    yield `Author: ${report.verdict.authorId}; recorded at: ${new Date(report.verdict.at).toISOString()}`;
    yield `Accessibility context considered: ${String(report.verdict.consideredAccessibilityContext)}`;
  }
}
