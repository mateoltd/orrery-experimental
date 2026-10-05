import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_BANNER, INTEGRITY_HELP, type TimelineFacts } from '../exam/integrity/timeline.js';
import {
  buildIntegrityReport,
  integrityLines,
  type RecordedReportVerdict,
} from './integrity-report.js';
import { Integrity } from './Reports.js';

const facts: TimelineFacts = {
  attemptId: 'a',
  entries: [
    {
      at: 20,
      type: 'FULLSCREEN_EXITED',
      severity: 'VIOLATION',
      phrase: 'fullscreen exited',
      crossedThreshold: 3,
      droppedEventCount: 2,
    },
    { at: 10, type: 'EXAM_STARTED', severity: 'INFO', phrase: 'exam started' },
  ],
  preflight: { fullscreen: 'denied' },
  forceExits: [{ at: 30, phase: 'final flush reported a network loss' }],
  similarityClusters: [{ id: 'c', responseIds: ['r1', 'r2', 'r3'] }],
  isFrozen: true,
  droppedEventCount: 2,
};
const verdict: RecordedReportVerdict = {
  conclusion: 'REVIEW',
  reason: 'Reviewed the work with the recorded accessibility context.',
  authorId: 'teacher',
  at: 40,
  supersedes: null,
  consideredAccessibilityContext: true,
};
const report = (patch = {}) =>
  buildIntegrityReport({ facts, verdict, similarityAvailable: true, computedAt: 50, ...patch });

describe('P11-T8 integrity report', () => {
  it('carries existing banner and RN-01 help onto the screen and PDF lines', () => {
    const result = report();
    render(<Integrity report={result} />);
    expect(screen.getByText(EVIDENCE_BANNER)).toBeVisible();
    expect(screen.getByText(`RN-01: ${INTEGRITY_HELP}`)).toBeVisible();
    const text = [...integrityLines(result)].join('\n');
    expect(text).toContain(EVIDENCE_BANNER);
    expect(text).toContain(INTEGRITY_HELP);
    for (const innocent of [
      'shared model answer',
      'group assignment',
      'dictation',
      'speech-to-text',
      'translation',
    ])
      expect(text).toContain(innocent);
  });
  it('displays chronology, preflight, crossings, losses, force-exits and response membership', () => {
    const result = report();
    expect(result.entries.map((e) => e.at)).toEqual([10, 20]);
    const text = [...integrityLines(result)].join('\n');
    expect(text).toContain('Preflight fullscreen: denied');
    expect(text).toContain('Threshold crossed: 3; dropped events: 2');
    expect(text).toContain('Force-exit report:');
    expect(text).toContain('response IDs r1, r2, r3');
    expect(text).toContain('1 × fullscreen exited');
  });
  it('displays recorded verdict, author, time and reason, never derives one from evidence', () => {
    expect(report().verdict).toEqual(verdict);
    const text = [...integrityLines(report())].join('\n');
    expect(text).toContain(`Reason: ${verdict.reason}`);
    expect(text).toContain('Author: teacher');
    expect(report({ verdict: null }).verdict).toBeNull();
    expect(report({ verdict: null }).verdictNotice).toContain('No teacher verdict');
  });
  it.each([{ authorId: '' }, { reason: '' }])(
    'refuses an incomplete human decision (%j)',
    (patch) => {
      expect(report({ verdict: { ...verdict, ...patch } }).verdict).toBeNull();
    },
  );
  it('does not legitimise a recorded void without evidence of an earlier freeze', () => {
    expect(
      report({
        facts: { ...facts, isFrozen: false },
        verdict: { ...verdict, conclusion: 'VOIDED' },
      }).verdict,
    ).toBeNull();
  });
  it('requires accessibility context when a recorded decision is displayed with similarity membership', () => {
    const result = report({ verdict: { ...verdict, consideredAccessibilityContext: false } });
    expect(result.verdict).toBeNull();
    expect(result.verdictNotice).toContain('requires review');
  });
  it('distinguishes unavailable similarity from an analysis that found no clusters', () => {
    expect(report({ similarityAvailable: false }).similarityNotice).toContain(
      'does not establish that responses differed',
    );
  });
  it('renders arbitrary teacher and preflight text as inert text', () => {
    const hostile = '</dd><script>alert(1)</script><img src=x onerror=alert(2)>';
    const result = report({
      facts: { ...facts, preflight: { device: hostile } },
      verdict: { ...verdict, reason: hostile },
    });
    const { container } = render(<Integrity report={result} />);
    expect(container.querySelector('script, img')).toBeNull();
    expect(container.textContent).toContain(hostile);
  });
});
