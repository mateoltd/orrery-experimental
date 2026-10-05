'use client';

/**
 * The grading workspace: the screen a review-queue row opens into.  (P9-T2, P9-T3)
 *
 * The decisions are made in the modules this file wires together, and each is stated where it is made:
 *
 *  · `layout.ts` -- what "side by side" means and the width at which it is given up.
 *  · `keymap.ts` -- which keys do what, where, and which keys are left to the browser.
 *  · `draft.ts` -- what is kept on the device, when, and what the teacher is told about it.
 *  · `markingState.ts` -- that a response nobody has marked has no number.
 *  · `rubric.ts` -- that a band, and any hand-entered mark, is between 0 and the question's points.
 *  · `submission.ts` -- what may leave the browser.
 *
 * What is decided HERE is where focus goes, because that is a property of the assembled screen and of nothing
 * smaller.
 *
 * ## FOCUS: ONE RULE, AND THE CASES IT COVERS
 *
 * `plans/15` rule 3: focus is never lost, and it is never taken for a background update. The rule this file follows
 * is: **focus stays where the teacher put it, unless the thing it was on has gone -- and then it goes to the
 * student's answer.**
 *
 *  · Moving between responses from inside the feedback field leaves focus IN the feedback field, now showing the
 *    next response's draft. That is "move between questions without leaving the answer field", and a polite
 *    announcement says which response it now is.
 *  · Moving onto a sealed response removes the field. Focus goes to the answer pane rather than to `<body>`, where
 *    every shortcut would silently stop working because the key listener is on the workspace.
 *  · Acting on an offer ("add the band's comment", "put my comment back") removes the button that was pressed. Focus
 *    goes to the feedback field, which is what the act changed.
 *  · A save refused for a missing mark or reason puts focus IN the field that is missing.
 *  · Opening the screen puts focus on the answer pane (`focusOnOpen`), because opening it is a navigation the teacher
 *    made and the answer is what they came to read. A caller that embeds the workspace in a page with its own focus
 *    plan can turn that off.
 *
 * Nothing announces through focus. The one live region is polite and speaks on a deliberate act -- a move, a band,
 * a save -- never on a keystroke and never on a draft write.
 *
 * ## THE KEY LISTENER IS ON THE WORKSPACE, NOT ON `document`
 *
 * A document-level listener would make `E` excuse a response while focus was on a button in the page's own
 * navigation. Scoping it to the workspace means the shortcuts work when focus is in the workspace and are inert
 * when it is not, which is the behaviour a person can predict.
 *
 * ## AND THERE IS NO NUMBER FOR THE ATTEMPT
 *
 * The header counts responses by state. It shows no total and no percentage: `computeScore` owns that arithmetic and
 * its `isProvisional` flag, and a running total here would be a provisional figure with nothing saying so.
 */

import type { Millis } from '@orrery/clock';
import type { TeacherQuestionSpec } from '@orrery/contracts/question';
import * as React from 'react';

import { AnswerView } from './AnswerView';
import {
  ACCEPT_AUTO_LABEL,
  ACCEPT_AUTO_NOTE,
  ANSWER_HEADING,
  AT_FIRST,
  AT_LAST,
  AWAITING_REASON,
  announcePosition,
  automaticReport,
  BAND_LEGEND,
  bandApplied,
  bandOption,
  CHANGED_WHILE_SAVING,
  CONCEPT_HINTS_LABEL,
  CONCEPT_HINTS_NOTE,
  countsLine,
  DISPLACED_INTRO,
  DISPLACED_RESTORE,
  DRAFT_DISCARD,
  DRAFT_DISCARDED,
  DRAFT_NONE,
  DRAFT_NOT_KEPT,
  DRAFT_RESTORED_SHORT,
  DRAFT_UNREADABLE,
  draftKept,
  draftRestored,
  EXCUSE_LABEL,
  EXCUSE_NOTE,
  EXCUSE_REASON_LABEL,
  EXCUSE_REASON_REQUIRED,
  EXCUSED_OFF,
  EXCUSED_ON,
  FEEDBACK_HINT,
  FEEDBACK_LABEL,
  FLAG_LABEL,
  FLAG_OFF,
  FLAG_ON,
  GUIDANCE_HEADING,
  MARK_HEADING,
  MARK_SAVED_SHORT,
  MARK_SAVING,
  MODEL_ANSWER_LABEL,
  markNotSaved,
  markSaved,
  NEXT_LABEL,
  NO_RESPONSES,
  NOTHING_ELSE_AWAITING,
  NOTHING_TO_SAVE,
  noSuchBand,
  OFFER_APPEND,
  OFFER_DISMISS,
  OFFER_INTRO,
  OFFER_REPLACE,
  PREFILL_HINT,
  PREVIOUS_LABEL,
  positionLine,
  QUICK_SCORED_NOTE,
  questionHeading,
  quickScoredLine,
  RAW_SCORE_NOTE,
  RELEASED_NOTE,
  REPLAY_HEADING,
  REQUEST_DID_NOT_COMPLETE,
  RESPONSES_NAV_LABEL,
  RUBRIC_EDIT_SUMMARY,
  SAVE_LABEL,
  SCORE_LABEL,
  SEALED_NO_MARK,
  SEALED_NOTE,
  SHORTCUT_COLUMNS,
  SHORTCUT_SCOPE,
  SHORTCUTS_CAPTION,
  SHORTCUTS_LABEL,
  SHORTCUTS_NOTE,
  SIM_NO_OUTCOME,
  SIM_REPLAY_NOTE,
  SIM_TRACE_EMPTY,
  STACKED_NOTE,
  simFaultLine,
  simGradedLine,
  stateLine,
  stateWord,
  TRACE_HEADING,
  workspaceTitle,
  worth,
} from './copy';
import {
  type DraftEvent,
  type DraftKey,
  type DraftStatus,
  type DraftStore,
  type MarkDraft,
  reduceDraft,
  sameDraft,
} from './draft';
import { focusKindOf, GRADING_KEYMAP, KEYS_OFF_ATTRIBUTE, resolveKey } from './keymap';
import {
  FRAME_CLASS,
  PANES_CLASS,
  paneClass,
  REPLAY_ATTRIBUTE,
  ROOT_CLASS,
  STACKED_NOTE_CLASS,
  workspaceCss,
} from './layout';
import {
  canAcceptAutomaticMark,
  countMarking,
  isMarkable,
  markingStateOf,
  nextAwaiting,
  type ResponseFacts,
  storedText,
} from './markingState';
import { RubricEditor, type SaveRubricResult } from './RubricEditor';
import {
  checkMark,
  fromSpecRubric,
  type MarkingBand,
  type MarkingRubric,
  prefillFor,
} from './rubric';
import {
  applyAcknowledged,
  buildSubmission,
  initialDraftFor,
  type MarkSubmission,
  type SaveMarkResult,
  type SubmissionField,
} from './submission';

export interface GradingWorkspaceProps {
  readonly attemptId: string;
  /**
   * How the attempt is named on screen. The caller decides whether that is a name or a candidate number; nothing in
   * here looks a student up.
   */
  readonly candidateLabel: string;
  /** IN PAPER ORDER. `J`/`K` walk this order and nothing here re-sorts it. */
  readonly responses: readonly ResponseFacts[];
  /** Whose drafts these are. Part of the draft key: see `draft.ts`. */
  readonly graderId: string;
  readonly store: DraftStore;
  /** Injected, per `INV-TIME-1`. */
  readonly now: () => Millis;
  /**
   * Save one mark. Resolves when the SERVER has acknowledged it, or says why it did not. The workspace says "saved"
   * on `ok: true` and on nothing else.
   */
  readonly onSaveMark: (submission: MarkSubmission) => Promise<SaveMarkResult>;
  /** Rubrics by question id. A `free_response` question without one uses the bands in its own spec. */
  readonly rubrics?: Readonly<Record<string, MarkingRubric>>;
  /** Absent means the rubric cannot be edited from here, and the editor is not drawn. */
  readonly onSaveRubric?: (rubric: MarkingRubric) => Promise<SaveRubricResult>;
  /** Results are out. Everything is read-only: a change now is a regrade (`plans/07` §7), not an edit. */
  readonly released?: boolean;
  readonly initialIndex?: number;
  readonly focusOnOpen?: boolean;
  readonly formatTime?: (at: Millis, form: 'TIME' | 'DATE_TIME') => string;
  /** P9-T7's live replay goes here. This lane draws what is STORED about a simulation answer and nothing more. */
  readonly renderReplay?: (facts: ResponseFacts) => React.ReactNode;
}

/** A response's working state in this tab. */
interface Session {
  readonly draft: MarkDraft;
  /** What the fields would show with no draft: the saved mark, or nothing. "Is there a draft" is `draft != baseline`. */
  readonly baseline: MarkDraft;
  readonly status: DraftStatus;
  /** Whether the draft as it stands is on the device. False after a refused write, whatever was there before. */
  readonly onDevice: boolean;
}

interface Acknowledged {
  /** The version of the caller's facts this was applied over. A different version from the caller wins. */
  readonly from: string;
  readonly facts: ResponseFacts;
}

type FocusWish = 'ANSWER' | 'ANSWER_ON_OPEN' | 'FEEDBACK' | 'REASON' | 'IF_LOST';

/** Marks the workspace's own live region, so a test can read it apart from the rubric editor's. */
export const ANNOUNCER_ATTRIBUTE = 'data-grading-announcer';

const CSS = workspaceCss();
const AS_WRITTEN: React.CSSProperties = { whiteSpace: 'pre-wrap' };

const defaultFormatTime = (at: Millis, form: 'TIME' | 'DATE_TIME'): string =>
  new Intl.DateTimeFormat(
    undefined,
    form === 'TIME'
      ? { hour: '2-digit', minute: '2-digit' }
      : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(new Date(at));

const effectiveFacts = (
  acknowledged: Readonly<Record<string, Acknowledged>>,
  facts: ResponseFacts,
): ResponseFacts => {
  const held = acknowledged[facts.responseId];
  return held !== undefined && held.from === facts.version ? held.facts : facts;
};

/** The rubric in force for a question, or `null` when it is marked without bands. */
const rubricFor = (
  spec: TeacherQuestionSpec,
  edited: Readonly<Record<string, MarkingRubric>>,
  supplied: Readonly<Record<string, MarkingRubric>> | undefined,
): MarkingRubric | null => {
  const own = edited[spec.id] ?? supplied?.[spec.id];
  if (own !== undefined) return own;
  // `Array.isArray`, because the spec came out of a JSON column and `rubric` is only an array by annotation.
  if (spec.type === 'free_response' && Array.isArray(spec.rubric) && spec.rubric.length > 0) {
    return fromSpecRubric(spec.id, spec.points, spec.rubric);
  }
  return null;
};

const Guidance = ({ spec }: { readonly spec: TeacherQuestionSpec }) => {
  const hints =
    spec.type === 'free_response' && Array.isArray(spec.conceptHints) ? spec.conceptHints : [];
  return (
    <>
      <h4>{GUIDANCE_HEADING}</h4>
      <p>{worth(spec.points)}</p>
      {spec.modelAnswer === undefined && hints.length === 0 ? null : (
        <dl>
          {spec.modelAnswer === undefined ? null : (
            <>
              <dt>{MODEL_ANSWER_LABEL}</dt>
              <dd style={AS_WRITTEN}>{spec.modelAnswer}</dd>
            </>
          )}
          {hints.length === 0 ? null : (
            <>
              <dt>{CONCEPT_HINTS_LABEL}</dt>
              <dd>
                {hints.join(', ')}. {CONCEPT_HINTS_NOTE}
              </dd>
            </>
          )}
        </dl>
      )}
    </>
  );
};

const SimReplay = ({
  facts,
  renderReplay,
}: {
  readonly facts: ResponseFacts;
  readonly renderReplay: GradingWorkspaceProps['renderReplay'];
}) => {
  const { spec, sim } = facts;
  const outcome = sim?.outcome ?? null;
  const trace = sim?.trace ?? [];
  return (
    <>
      {spec.type === 'simulation' ? (
        <p>
          {sim?.title === undefined ? '' : `${sim.title} `}
          <small>
            {spec.simId}@{spec.simVersion}
          </small>
        </p>
      ) : null}
      <p>{SIM_REPLAY_NOTE}</p>
      <p>
        {outcome === null
          ? SIM_NO_OUTCOME
          : outcome.kind === 'GRADED'
            ? simGradedLine(outcome.points, outcome.maxPoints, outcome.code)
            : simFaultLine(outcome.reason, outcome.detail)}
      </p>
      <h4>{TRACE_HEADING}</h4>
      {trace.length === 0 ? (
        <p>{SIM_TRACE_EMPTY}</p>
      ) : (
        <ol>
          {trace.map((entry, step) => (
            // A trace is an ordered log with no ids of its own, and it is never reordered: the position IS the key.
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only stored log, rendered once and never reordered
            <li key={step}>
              <code style={AS_WRITTEN}>{storedText(entry)}</code>
            </li>
          ))}
        </ol>
      )}
      {renderReplay?.(facts)}
    </>
  );
};

const DraftStatusLine = ({
  status,
  format,
}: {
  readonly status: DraftStatus;
  readonly format: (at: Millis, form: 'TIME' | 'DATE_TIME') => string;
}) => {
  switch (status.kind) {
    case 'NOTHING_TO_KEEP':
      return <p>{DRAFT_NONE}</p>;
    case 'KEPT':
      // NOT a live region. It changes on every edit, and announcing it would read the clock aloud per keystroke.
      return <p>{draftKept(format(status.at, 'TIME'))}</p>;
    case 'NOT_KEPT':
      // AN ALERT. A draft the teacher believes is kept, and is not, is the failure this whole feature must not have.
      return <p role="alert">{DRAFT_NOT_KEPT}</p>;
    case 'RESTORED':
      return <p>{draftRestored(format(status.at, 'DATE_TIME'), status.stale)}</p>;
    case 'UNREADABLE':
      return <p>{DRAFT_UNREADABLE}</p>;
    case 'SAVING':
      return <p>{MARK_SAVING}</p>;
    case 'SAVED':
      return <p>{markSaved(format(status.at, 'TIME'))}</p>;
    case 'SAVE_FAILED':
      return <p role="alert">{markNotSaved(status.reason, status.kept)}</p>;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const ShortcutsHelp = ({
  detailsRef,
  summaryRef,
}: {
  readonly detailsRef: React.RefObject<HTMLDetailsElement | null>;
  readonly summaryRef: React.RefObject<HTMLElement | null>;
}) => (
  // Keys off inside: `J` while reading the list of shortcuts should not move the response underneath it.
  <details ref={detailsRef} {...{ [KEYS_OFF_ATTRIBUTE]: 'off' }}>
    <summary ref={summaryRef}>{SHORTCUTS_LABEL}</summary>
    <table>
      <caption>{SHORTCUTS_CAPTION}</caption>
      <thead>
        <tr>
          {SHORTCUT_COLUMNS.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {/* Rendered FROM the key map, so the list a teacher reads cannot disagree with the keys that work. */}
        {GRADING_KEYMAP.map((binding) => (
          <tr key={binding.chord}>
            <th scope="row">
              <kbd>{binding.chord}</kbd>
            </th>
            <td>{binding.description}</td>
            <td>{SHORTCUT_SCOPE[binding.scope]}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p>{SHORTCUTS_NOTE}</p>
  </details>
);

export function GradingWorkspace({
  attemptId,
  candidateLabel,
  responses,
  graderId,
  store,
  now,
  onSaveMark,
  rubrics,
  onSaveRubric,
  released = false,
  initialIndex = 0,
  focusOnOpen = true,
  formatTime = defaultFormatTime,
  renderReplay,
}: GradingWorkspaceProps) {
  const baseId = React.useId();
  const total = responses.length;
  const clamp = (value: number): number => Math.min(Math.max(value, 0), Math.max(total - 1, 0));

  const [index, setIndexState] = React.useState(() => clamp(initialIndex));
  /**
   * Nothing is read from the device until the component has mounted. A server render has no device, and reading in
   * the first render would make the server's markup and the browser's disagree about whether a draft exists.
   */
  const [mounted, setMounted] = React.useState(false);
  const [sessions, setSessionsState] = React.useState<Readonly<Record<string, Session>>>({});
  const [acknowledged, setAcknowledgedState] = React.useState<
    Readonly<Record<string, Acknowledged>>
  >({});
  const [editedRubrics, setEditedRubrics] = React.useState<Readonly<Record<string, MarkingRubric>>>(
    {},
  );
  const [problem, setProblem] = React.useState<{
    readonly responseId: string;
    readonly field: SubmissionField;
    readonly message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = React.useState({ serial: 0, text: '' });

  /**
   * REFS THAT MIRROR STATE, for the one path that outlives a render: `save` awaits the server and then has to read
   * what the draft is NOW, not what it was when Enter was pressed. Each is written in the same call that sets the
   * state, never separately, so the two cannot disagree.
   */
  const sessionsRef = React.useRef(sessions);
  const acknowledgedRef = React.useRef(acknowledged);
  const indexRef = React.useRef(index);
  const responsesRef = React.useRef(responses);
  responsesRef.current = responses;
  const saving = React.useRef(false);

  const rootRef = React.useRef<HTMLElement>(null);
  const answerPaneRef = React.useRef<HTMLElement>(null);
  const scoreRef = React.useRef<HTMLInputElement>(null);
  const feedbackRef = React.useRef<HTMLTextAreaElement>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const helpRef = React.useRef<HTMLDetailsElement>(null);
  const helpSummaryRef = React.useRef<HTMLElement>(null);
  const focusWish = React.useRef<FocusWish | null>(null);

  const putSession = (responseId: string, session: Session): void => {
    const next = { ...sessionsRef.current, [responseId]: session };
    sessionsRef.current = next;
    setSessionsState(next);
  };
  const putAcknowledged = (responseId: string, held: Acknowledged): void => {
    const next = { ...acknowledgedRef.current, [responseId]: held };
    acknowledgedRef.current = next;
    setAcknowledgedState(next);
  };
  const setIndex = (next: number): void => {
    indexRef.current = next;
    setIndexState(next);
  };
  const announce = (text: string): void => {
    setAnnouncement((previous) => ({ serial: previous.serial + 1, text }));
  };

  const keyFor = (facts: ResponseFacts): DraftKey => ({
    graderId,
    attemptId,
    responseId: facts.responseId,
  });

  /** What a response opens with: the device's draft if there is one that differs from the saved mark. */
  const load = (facts: ResponseFacts): Session => {
    const baseline = initialDraftFor(facts);
    const read = store.read(keyFor(facts));
    if (read.kind === 'UNREADABLE') {
      return { draft: baseline, baseline, status: { kind: 'UNREADABLE' }, onDevice: false };
    }
    if (read.kind === 'FOUND' && !sameDraft(read.stored.draft, baseline)) {
      return {
        draft: read.stored.draft,
        baseline,
        status: {
          kind: 'RESTORED',
          at: read.stored.keptAt,
          // Written against a different version of the response: someone has marked or changed it since.
          stale: read.stored.basedOn !== facts.version,
        },
        onDevice: true,
      };
    }
    return { draft: baseline, baseline, status: { kind: 'NOTHING_TO_KEEP' }, onDevice: false };
  };

  const sessionOf = (facts: ResponseFacts): Session =>
    sessionsRef.current[facts.responseId] ?? load(facts);

  /** Write the draft to the device and report what happened. The ONLY place a draft is written or removed on edit. */
  const persist = (
    facts: ResponseFacts,
    draft: MarkDraft,
    baseline: MarkDraft,
  ): Pick<Session, 'status' | 'onDevice'> => {
    if (sameDraft(draft, baseline)) {
      // Edited back to the saved mark. There is no draft, so nothing is left on the device to be restored later.
      store.remove(keyFor(facts));
      return { status: { kind: 'NOTHING_TO_KEEP' }, onDevice: false };
    }
    const at = now();
    const written = store.write(keyFor(facts), { draft, keptAt: at, basedOn: facts.version });
    return written.ok
      ? { status: { kind: 'KEPT', at }, onDevice: true }
      : { status: { kind: 'NOT_KEPT' }, onDevice: false };
  };

  const paper = responses.map((facts) => effectiveFacts(acknowledged, facts));
  const at = clamp(index);
  const current = paper[at];

  React.useEffect(() => {
    setMounted(true);
    if (focusOnOpen) focusWish.current = 'ANSWER_ON_OPEN';
  }, [focusOnOpen]);

  /**
   * FOCUS, after every render. A ref rather than state, so asking for focus does not itself cause a render -- and so
   * a wish is consumed exactly once.
   */
  React.useEffect(() => {
    const wish = focusWish.current;
    if (wish === null) return;
    focusWish.current = null;
    const root = rootRef.current;
    if (root === null) return;
    if (wish === 'ANSWER_ON_OPEN') {
      /**
       * WITHOUT SCROLLING. In the stacked arrangement the answer is below the header and the question, and a plain
       * `focus()` scrolls it to the top of the window -- so the screen opened with the question already off the
       * top of it, which a real browser showed and jsdom, having no layout, could not. Focus is placed; the page
       * stays where a page opens.
       */
      answerPaneRef.current?.focus({ preventScroll: true });
      return;
    }
    if (wish === 'IF_LOST') {
      // The focused control is still there: leave it alone. It has gone: go to the answer, not to `<body>`.
      if (!root.contains(document.activeElement)) answerPaneRef.current?.focus();
      return;
    }
    const target =
      wish === 'FEEDBACK'
        ? feedbackRef.current
        : wish === 'REASON'
          ? reasonRef.current
          : answerPaneRef.current;
    (target ?? answerPaneRef.current)?.focus();
  });

  /**
   * LEAVING WITH A DRAFT THE DEVICE REFUSED TO KEEP. The one case where the browser's own "leave this page?" prompt
   * is warranted: the draft is in this tab and nowhere else. Not registered otherwise -- a prompt on every exit is a
   * prompt nobody reads.
   */
  const unkept = Object.values(sessions).some(
    (session) => !session.onDevice && !sameDraft(session.draft, session.baseline),
  );
  React.useEffect(() => {
    if (!unkept) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [unkept]);

  if (current === undefined) {
    return (
      <section ref={rootRef} className={ROOT_CLASS} aria-label={workspaceTitle(candidateLabel)}>
        <p>{NO_RESPONSES}</p>
      </section>
    );
  }

  const facts = current;
  const state = markingStateOf(facts);
  const session = sessions[facts.responseId] ?? (mounted ? load(facts) : null);
  const baseline = session?.baseline ?? initialDraftFor(facts);
  const draft = session?.draft ?? baseline;
  const status: DraftStatus = session?.status ?? { kind: 'NOTHING_TO_KEEP' };

  const editable = !released && isMarkable(facts);
  const rubric = rubricFor(facts.spec, editedRubrics, rubrics);
  const bands = rubric?.bands ?? [];
  const maxPoints = facts.spec.points;
  const hasReplay = facts.spec.type === 'simulation';
  const hasDraft = !sameDraft(draft, baseline);
  const prefillStanding = draft.prefill !== null && draft.feedback === draft.prefill.text;
  const problemHere = problem?.responseId === facts.responseId ? problem : null;

  const ids = {
    title: `${baseId}-title`,
    question: `${baseId}-question`,
    answer: `${baseId}-answer`,
    replay: `${baseId}-replay`,
    marking: `${baseId}-marking`,
    score: `${baseId}-score`,
    scoreProblem: `${baseId}-score-problem`,
    feedback: `${baseId}-feedback`,
    feedbackHint: `${baseId}-feedback-hint`,
    reason: `${baseId}-reason`,
    reasonProblem: `${baseId}-reason-problem`,
    acceptNote: `${baseId}-accept-note`,
  };

  /* ───────────────────────────────────────────────────────── the acts ── */

  const edit = (event: DraftEvent): MarkDraft => {
    const held = sessionOf(facts);
    const next = reduceDraft(held.draft, event);
    if (next === held.draft) return next;
    putSession(facts.responseId, { ...held, draft: next, ...persist(facts, next, held.baseline) });
    if (problemHere !== null) setProblem(null);
    return next;
  };

  /** What to add to a "you are now on response N" announcement about the draft found there. */
  const arrival = (target: ResponseFacts, position: number): string => {
    const found = sessionOf(target).status.kind;
    return (
      announcePosition(position, total, markingStateOf(target)) +
      (found === 'RESTORED' ? ` ${DRAFT_RESTORED_SHORT}` : '') +
      (found === 'UNREADABLE' ? ` ${DRAFT_UNREADABLE}` : '')
    );
  };

  const goTo = (next: number): void => {
    if (next < 0) {
      announce(AT_FIRST);
      return;
    }
    const target = paper[next];
    if (target === undefined) {
      announce(AT_LAST);
      return;
    }
    focusWish.current = 'IF_LOST';
    setIndex(next);
    announce(arrival(target, next + 1));
  };

  /** Go to the next response still awaiting a mark, after `from`. `said` is what just happened, announced first. */
  const advanceFrom = (from: number, said: string): void => {
    const paperNow = responsesRef.current.map((raw) =>
      effectiveFacts(acknowledgedRef.current, raw),
    );
    const next = nextAwaiting(paperNow, from);
    const target = next === null ? undefined : paperNow[next];
    if (next === null || target === undefined) {
      announce(`${said} ${NOTHING_ELSE_AWAITING}`);
      return;
    }
    focusWish.current = 'IF_LOST';
    setIndex(next);
    announce(`${said} ${arrival(target, next + 1)}`);
  };

  const applyBand = (band: MarkingBand, position: number, via: 'KEY' | 'CONTROL'): void => {
    const after = edit({ type: 'BAND_APPLIED', band, via });
    const comment =
      prefillFor(band) === null
        ? 'NONE'
        : after.offered?.bandId === band.id
          ? 'OFFERED'
          : after.prefill?.bandId === band.id
            ? 'PREFILLED'
            : 'UNCHANGED';
    announce(bandApplied(position, band.points, maxPoints, comment));
  };

  const applyDigit = (digit: number): void => {
    if (!editable) {
      announce(released ? RELEASED_NOTE : SEALED_NO_MARK);
      return;
    }
    if (bands.length > 0) {
      const band = bands[digit - 1];
      if (band === undefined) {
        announce(noSuchBand(digit));
        return;
      }
      applyBand(band, digit, 'KEY');
      return;
    }
    // NO RUBRIC: the digit is the mark, through the same door as a typed one. `7` on a 5-mark question is refused
    // and said to be, not clamped to 5.
    const mark = checkMark(digit, maxPoints);
    if (!mark.ok) {
      announce(mark.message);
      return;
    }
    edit({ type: 'QUICK_SCORED', points: mark.points });
    announce(quickScoredLine(mark.points, maxPoints));
  };

  const toggleExcuse = (via: 'KEY' | 'CONTROL'): void => {
    if (!editable) {
      announce(released ? RELEASED_NOTE : SEALED_NO_MARK);
      return;
    }
    const after = edit({ type: 'EXCUSE_TOGGLED' });
    announce(after.excused ? EXCUSED_ON : EXCUSED_OFF);
    // The KEY moves focus to the reason, because the next thing to do is type it. The CHECKBOX does not: a
    // setting that moves focus when it is changed is a change of context the person did not ask for.
    if (after.excused && via === 'KEY') focusWish.current = 'REASON';
  };

  const toggleFlag = (): void => {
    if (released) {
      announce(RELEASED_NOTE);
      return;
    }
    const after = edit({ type: 'FLAG_TOGGLED' });
    announce(after.flagged ? FLAG_ON : FLAG_OFF);
  };

  const openFeedback = (): void => {
    if (!editable) {
      announce(released ? RELEASED_NOTE : SEALED_NO_MARK);
      return;
    }
    feedbackRef.current?.focus();
  };

  const openHelp = (): void => {
    if (helpRef.current !== null) helpRef.current.open = true;
    helpSummaryRef.current?.focus();
  };

  const discardDraft = (): void => {
    const held = sessionOf(facts);
    store.remove(keyFor(facts));
    putSession(facts.responseId, {
      draft: held.baseline,
      baseline: held.baseline,
      status: { kind: 'NOTHING_TO_KEEP' },
      onDevice: false,
    });
    setProblem(null);
    // The button that was pressed is about to disappear.
    focusWish.current = 'ANSWER';
    announce(DRAFT_DISCARDED);
  };

  const save = async (): Promise<void> => {
    // ONE SAVE AT A TIME. A second Enter while the first is in flight must not send the mark twice, and must not
    // advance past a response whose save has not been acknowledged.
    if (saving.current) return;
    if (released) {
      announce(RELEASED_NOTE);
      return;
    }
    const from = indexRef.current;
    const raw = responsesRef.current[from];
    if (raw === undefined) return;
    const target = effectiveFacts(acknowledgedRef.current, raw);
    const held = sessionOf(target);

    const built = buildSubmission(target, held.draft, EXCUSE_REASON_REQUIRED);
    if (!built.ok) {
      // REFUSED, and focus goes INTO the field that is missing. Nothing was sent and nothing advanced.
      setProblem({ responseId: target.responseId, field: built.field, message: built.message });
      announce(built.message);
      (built.field === 'score' ? scoreRef.current : reasonRef.current)?.focus();
      return;
    }
    if (built.submission === null) {
      advanceFrom(from, NOTHING_TO_SAVE);
      return;
    }

    const submitted = held.draft;
    saving.current = true;
    putSession(target.responseId, { ...held, status: { kind: 'SAVING' } });

    let result: SaveMarkResult;
    try {
      result = await onSaveMark(built.submission);
    } catch {
      // A rejected promise is a failed save, not an unhandled error and not a silence.
      result = { ok: false, reason: REQUEST_DID_NOT_COMPLETE };
    }
    saving.current = false;

    const latest = sessionsRef.current[target.responseId] ?? held;
    if (!result.ok) {
      // NOT SAVED. The draft stays exactly where it is, the screen does not move on, and the status says whether
      // the draft is still on the device -- which is the only thing the teacher needs to know next.
      putSession(target.responseId, {
        ...latest,
        status: { kind: 'SAVE_FAILED', reason: result.reason, kept: latest.onDevice },
      });
      return;
    }

    const after = applyAcknowledged(target, built.submission, result.version);
    putAcknowledged(target.responseId, { from: raw.version, facts: after });
    const settled = initialDraftFor(after);

    if (!sameDraft(latest.draft, submitted)) {
      // EDITED WHILE THE SAVE WAS IN FLIGHT. What was sent is saved; what was typed since is not, and removing the
      // draft now would delete it. It stays a draft, against the new baseline, and the screen does not move on.
      putSession(target.responseId, {
        draft: latest.draft,
        baseline: settled,
        ...persist(after, latest.draft, settled),
      });
      announce(CHANGED_WHILE_SAVING);
      return;
    }

    // Acknowledged, and nothing typed since: the draft has done its job and is removed from the device.
    store.remove(keyFor(target));
    putSession(target.responseId, {
      draft: settled,
      baseline: settled,
      status: { kind: 'SAVED', at: now() },
      onDevice: false,
    });
    advanceFrom(from, MARK_SAVED_SHORT);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const resolved = resolveKey(
      {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      },
      focusKindOf(event.target instanceof Element ? event.target : null),
    );
    // NOT OURS. No `preventDefault`: the key goes to the field, the control or the browser as if this listener did
    // not exist.
    if (resolved === null) return;
    event.preventDefault();

    switch (resolved.action) {
      case 'response.next':
        goTo(indexRef.current + 1);
        return;
      case 'response.previous':
        goTo(indexRef.current - 1);
        return;
      case 'mark.saveAndNext':
        void save();
        return;
      case 'mark.digit':
        applyDigit(resolved.digit);
        return;
      case 'mark.excuse':
        toggleExcuse('KEY');
        return;
      case 'mark.flag':
        toggleFlag();
        return;
      case 'feedback.open':
        openFeedback();
        return;
      case 'help.open':
        openHelp();
        return;
      default: {
        // `never` here is the point: an action added to the key map without a case above is a compile error.
        const exhaustive: never = resolved;
        void exhaustive;
      }
    }
  };

  /** After an offer or a restore, the button pressed is gone. The feedback field is what it changed. */
  const actOnComment = (event: DraftEvent): void => {
    edit(event);
    focusWish.current = 'FEEDBACK';
  };

  return (
    <section ref={rootRef} className={ROOT_CLASS} aria-labelledby={ids.title} onKeyDown={onKeyDown}>
      {/* Text children, generated from constants in `layout.ts`. Nothing here is interpolated from data. */}
      <style>{CSS}</style>
      <div className={FRAME_CLASS}>
        <header>
          <h2 id={ids.title}>{workspaceTitle(candidateLabel)}</h2>
          <p>{countsLine(countMarking(paper))}</p>
          {released ? <p>{RELEASED_NOTE}</p> : null}
          <p className={STACKED_NOTE_CLASS}>{STACKED_NOTE}</p>
          <nav aria-label={RESPONSES_NAV_LABEL}>
            <button
              type="button"
              onClick={() => {
                goTo(at - 1);
              }}
            >
              {PREVIOUS_LABEL}
            </button>{' '}
            <span>
              {positionLine(at + 1, total)}, {stateWord(state)}
            </span>{' '}
            <button
              type="button"
              onClick={() => {
                goTo(at + 1);
              }}
            >
              {NEXT_LABEL}
            </button>
          </nav>
        </header>

        <div className={PANES_CLASS} {...{ [REPLAY_ATTRIBUTE]: String(hasReplay) }}>
          {/*
            THE PANES ARE FOCUSABLE because they scroll. A region that scrolls and cannot take focus cannot be
            scrolled from the keyboard at all, which would leave a keyboard user unable to read the end of a long
            answer.
          */}
          <section
            className={paneClass('question')}
            aria-labelledby={ids.question}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling pane must take focus to be scrolled by keyboard
            tabIndex={0}
          >
            <h3 id={ids.question}>{questionHeading(at + 1)}</h3>
            <div style={AS_WRITTEN}>{facts.prompt}</div>
            <Guidance spec={facts.spec} />
          </section>

          <section
            ref={answerPaneRef}
            className={paneClass('answer')}
            aria-labelledby={ids.answer}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling pane must take focus to be scrolled by keyboard
            tabIndex={0}
          >
            <h3 id={ids.answer}>{ANSWER_HEADING}</h3>
            <AnswerView facts={facts} />
          </section>

          {hasReplay ? (
            <section
              className={paneClass('replay')}
              aria-labelledby={ids.replay}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling pane must take focus to be scrolled by keyboard
              tabIndex={0}
            >
              <h3 id={ids.replay}>{REPLAY_HEADING}</h3>
              <SimReplay facts={facts} renderReplay={renderReplay} />
            </section>
          ) : null}

          <section className={paneClass('marking')} aria-labelledby={ids.marking}>
            <h3 id={ids.marking}>{MARK_HEADING}</h3>

            {/*
              THE STATE, from `markingStateOf` and never from `auto.points`. For a response awaiting a mark this
              line has no number in it, because the state has none to give.
            */}
            <p>{stateLine(state)}</p>
            {state.kind === 'AWAITING_MARK' ? <p>{AWAITING_REASON[state.why]}</p> : null}
            {facts.auto !== null &&
            (state.kind === 'MARKED_AUTOMATICALLY' ||
              (state.kind === 'AWAITING_MARK' && state.why === 'PENALISED_BELOW_ZERO')) ? (
              <p>{automaticReport(facts.auto.rationale.explanation)}</p>
            ) : null}
            {state.kind === 'MARKED_AUTOMATICALLY' &&
            facts.auto !== null &&
            facts.auto.rawPoints !== facts.auto.points ? (
              <p>{RAW_SCORE_NOTE(facts.auto.rawPoints)}</p>
            ) : null}
            {state.kind === 'MARKED_AUTOMATICALLY' ? <p>{SEALED_NOTE}</p> : null}

            {editable ? (
              <>
                {bands.length > 0 ? (
                  <fieldset>
                    <legend>{BAND_LEGEND}</legend>
                    {bands.map((band, position) => (
                      <div key={band.id}>
                        <label>
                          <input
                            type="radio"
                            name={`${baseId}-band`}
                            checked={draft.bandId === band.id}
                            onChange={() => {
                              applyBand(band, position + 1, 'CONTROL');
                            }}
                          />{' '}
                          {bandOption(position + 1, band.points, band.descriptor)}
                        </label>
                      </div>
                    ))}
                  </fieldset>
                ) : null}

                {canAcceptAutomaticMark(facts) ? (
                  <div>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.acceptAuto}
                        aria-describedby={ids.acceptNote}
                        onChange={() => {
                          edit({ type: 'ACCEPT_AUTO_TOGGLED' });
                        }}
                      />{' '}
                      {ACCEPT_AUTO_LABEL}
                    </label>
                    <p id={ids.acceptNote}>{ACCEPT_AUTO_NOTE}</p>
                  </div>
                ) : null}

                <div>
                  <label htmlFor={ids.score}>{SCORE_LABEL(maxPoints)}</label>
                  {/* `type="text"` with `inputMode`, as the numeric renderer does: `type="number"` discards what it cannot parse. */}
                  <input
                    ref={scoreRef}
                    id={ids.score}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={draft.score}
                    aria-invalid={problemHere?.field === 'score'}
                    aria-describedby={problemHere?.field === 'score' ? ids.scoreProblem : undefined}
                    onChange={(event) => {
                      edit({ type: 'SCORE_TYPED', raw: event.target.value });
                    }}
                  />
                  {problemHere?.field === 'score' ? (
                    <p id={ids.scoreProblem}>{problemHere.message}</p>
                  ) : null}
                  {draft.quickScored ? <p>{QUICK_SCORED_NOTE}</p> : null}
                </div>

                <div>
                  <label htmlFor={ids.feedback}>{FEEDBACK_LABEL}</label>
                  <textarea
                    ref={feedbackRef}
                    id={ids.feedback}
                    rows={5}
                    value={draft.feedback}
                    aria-describedby={ids.feedbackHint}
                    onChange={(event) => {
                      edit({ type: 'FEEDBACK_EDITED', text: event.target.value });
                    }}
                  />
                  {/* While a prefill stands untouched, the hint says whose comment it is. */}
                  <p id={ids.feedbackHint}>{prefillStanding ? PREFILL_HINT : FEEDBACK_HINT}</p>

                  {draft.offered === null ? null : (
                    <div>
                      <p>{OFFER_INTRO}</p>
                      <blockquote style={AS_WRITTEN}>{draft.offered.text}</blockquote>
                      <button
                        type="button"
                        onClick={() => {
                          actOnComment({ type: 'OFFER_APPENDED' });
                        }}
                      >
                        {OFFER_APPEND}
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => {
                          actOnComment({ type: 'OFFER_REPLACED' });
                        }}
                      >
                        {OFFER_REPLACE}
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => {
                          actOnComment({ type: 'OFFER_DISMISSED' });
                        }}
                      >
                        {OFFER_DISMISS}
                      </button>
                    </div>
                  )}

                  {draft.displaced === null ? null : (
                    <div>
                      <p>{DISPLACED_INTRO}</p>
                      <button
                        type="button"
                        onClick={() => {
                          actOnComment({ type: 'DISPLACED_RESTORED' });
                        }}
                      >
                        {DISPLACED_RESTORE}
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.excused}
                      onChange={() => {
                        toggleExcuse('CONTROL');
                      }}
                    />{' '}
                    {EXCUSE_LABEL}
                  </label>
                  {draft.excused ? (
                    <>
                      <p>{EXCUSE_NOTE}</p>
                      <label htmlFor={ids.reason}>{EXCUSE_REASON_LABEL}</label>
                      <textarea
                        ref={reasonRef}
                        id={ids.reason}
                        rows={2}
                        value={draft.excuseReason}
                        aria-invalid={problemHere?.field === 'excuseReason'}
                        aria-describedby={
                          problemHere?.field === 'excuseReason' ? ids.reasonProblem : undefined
                        }
                        onChange={(event) => {
                          edit({ type: 'EXCUSE_REASON_EDITED', text: event.target.value });
                        }}
                      />
                      {problemHere?.field === 'excuseReason' ? (
                        <p id={ids.reasonProblem}>{problemHere.message}</p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </>
            ) : null}

            {released ? null : (
              <>
                <div>
                  <label>
                    <input type="checkbox" checked={draft.flagged} onChange={toggleFlag} />{' '}
                    {FLAG_LABEL}
                  </label>
                </div>

                <DraftStatusLine status={status} format={formatTime} />
                {hasDraft ? (
                  <button type="button" onClick={discardDraft}>
                    {DRAFT_DISCARD}
                  </button>
                ) : null}

                <div>
                  <button
                    type="button"
                    onClick={() => {
                      void save();
                    }}
                  >
                    {SAVE_LABEL}
                  </button>
                </div>
              </>
            )}

            {editable && onSaveRubric !== undefined ? (
              <details {...{ [KEYS_OFF_ATTRIBUTE]: 'off' }}>
                <summary>{RUBRIC_EDIT_SUMMARY}</summary>
                <RubricEditor
                  // A different question is a different rubric: remount, so one question's half-edited bands are
                  // never shown under another's heading.
                  key={facts.questionId}
                  rubric={rubric ?? { questionId: facts.questionId, maxPoints, bands: [] }}
                  onSave={async (next) => {
                    const result = await onSaveRubric(next);
                    // The bands the digit keys address change only once the save is acknowledged. Until then `2`
                    // means what it meant when the teacher last looked.
                    if (result.ok) {
                      setEditedRubrics((held) => ({ ...held, [facts.questionId]: next }));
                    }
                    return result;
                  }}
                />
              </details>
            ) : null}
          </section>
        </div>

        <footer>
          <ShortcutsHelp detailsRef={helpRef} summaryRef={helpSummaryRef} />
        </footer>

        {/*
          THE ONE LIVE REGION. Polite, and written to only by a deliberate act. The `key` replaces the node so the
          same sentence twice in a row -- "Flag removed." -- is announced twice.
        */}
        <p role="status" className="visually-hidden" {...{ [ANNOUNCER_ATTRIBUTE]: '' }}>
          <span key={announcement.serial}>{announcement.text}</span>
        </p>
      </div>
    </section>
  );
}
