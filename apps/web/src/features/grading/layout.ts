/**
 * Where the panes go, and at what width that stops being possible.  (P9-T2)
 *
 * ## "SIDE BY SIDE" MEANS A TEACHER NEVER SCROLLS TO COMPARE
 *
 * `plans/07` §5.1: "Prompt, student answer and sim replay side by side." The requirement is not about columns. It is
 * that the thing being judged and the thing it is judged against are on screen TOGETHER, because a marker who has to
 * scroll between them is marking from memory.
 *
 * That is a claim about pixels, and there are widths at which it cannot be kept. So this file states three
 * arrangements and the exact width each one starts at, rather than leaving it to whatever a flex container does:
 *
 *  · `SIDE_BY_SIDE`, at 1280px and wider. Question, answer and the marking panel are three columns. On a simulation
 *    question the question sits above the answer in the first column and the replay takes the second -- both of
 *    those are short on a simulation item, and the replay is the pane that needs the room.
 *  · `EVIDENCE_OVER_MARKING`, from 800px. Question and answer (and replay) stay side by side; the marking panel
 *    moves BENEATH them, capped at 45% of the height. What is compared stays together; what is typed moves.
 *  · `STACKED`, below 800px. One column. **The guarantee is not kept here and the screen says so** (`STACKED_NOTE`):
 *    at that width two readable columns do not fit, and `plans/15` rule 9 requires reflow at 320px without loss of
 *    content, which side-by-side columns would break.
 *
 * In the first two, each pane scrolls on its own. A long answer scrolls inside its pane while the question stays put.
 *
 * ## THE WIDTH IS THE WORKSPACE'S, NOT THE WINDOW'S
 *
 * A container query, not a media query. A 1280px laptop with a 240px navigation rail gives this screen 1040px, and a
 * media query would lay out three columns in the space of two. It also means browser zoom does the right thing: at
 * 200% a 1280px window is 640 CSS pixels wide and gets the stacked arrangement, which is rule 9 again.
 *
 * ## THE DOM ORDER NEVER CHANGES
 *
 * Question, answer, replay, mark -- in every arrangement. Only `grid-template-areas` moves. `plans/15` rule 5 asks
 * for a "documented and stable order", and a layout that reordered the DOM by width would make the tab order depend
 * on the size of the window.
 *
 * ## WHAT A UNIT TEST CAN AND CANNOT SAY ABOUT THIS
 *
 * jsdom computes no layout. The tests here pin the thresholds and that the stylesheet is generated FROM them, so the
 * two cannot drift. Whether the panes are actually beside each other at 1280px is a question only a real browser
 * answers.
 */

export type LayoutMode = 'SIDE_BY_SIDE' | 'EVIDENCE_OVER_MARKING' | 'STACKED';

/** The inline size, in CSS pixels, at which three columns fit. */
export const SIDE_BY_SIDE_MIN_PX = 1280;
/** Below this, two readable columns do not fit and the panes stack. */
export const STACKED_BELOW_PX = 800;
/** The marking panel's share of the height when it sits beneath the evidence. */
export const MARKING_MAX_BLOCK_PERCENT = 45;

export const layoutFor = (inlineSizePx: number): LayoutMode => {
  if (inlineSizePx >= SIDE_BY_SIDE_MIN_PX) return 'SIDE_BY_SIDE';
  if (inlineSizePx >= STACKED_BELOW_PX) return 'EVIDENCE_OVER_MARKING';
  return 'STACKED';
};

export const ROOT_CLASS = 'orrery-grading';
export const FRAME_CLASS = 'orrery-grading__frame';
export const PANES_CLASS = 'orrery-grading__panes';
export const PANE_CLASS = 'orrery-grading__pane';
export const STACKED_NOTE_CLASS = 'orrery-grading__stacked-note';
/** Set on the panes container when the response has a simulation replay. */
export const REPLAY_ATTRIBUTE = 'data-replay';

export type PaneName = 'question' | 'answer' | 'replay' | 'marking';
/** DOM order, and therefore tab order, in every arrangement. */
export const PANE_ORDER: readonly PaneName[] = ['question', 'answer', 'replay', 'marking'];
export const paneClass = (pane: PaneName): string => `${PANE_CLASS} ${PANE_CLASS}--${pane}`;

/**
 * THE GRID AREAS for an arrangement, as rows of area names. Exported so the stylesheet and the tests read one table.
 */
export const gridAreas = (
  mode: Exclude<LayoutMode, 'STACKED'>,
  hasReplay: boolean,
): readonly (readonly PaneName[])[] => {
  if (mode === 'SIDE_BY_SIDE') {
    return hasReplay
      ? [
          ['question', 'replay', 'marking'],
          ['answer', 'replay', 'marking'],
        ]
      : [['question', 'answer', 'marking']];
  }
  return hasReplay
    ? [
        ['question', 'replay'],
        ['answer', 'replay'],
        ['marking', 'marking'],
      ]
    : [
        ['question', 'answer'],
        ['marking', 'marking'],
      ];
};

const areasCss = (rows: readonly (readonly PaneName[])[]): string =>
  rows.map((row) => `"${row.join(' ')}"`).join(' ');

/**
 * THE STYLESHEET, generated from the constants above.
 *
 * A string rather than a `.css` file because the thresholds have to be the SAME numbers `layoutFor` uses, and two
 * files holding one number each is how they come apart. It is rendered as the text of a `<style>` element -- React
 * text, never `innerHTML` -- and nothing in it is interpolated from data.
 *
 * `--orrery-grading-offset` is the height of whatever chrome the host page puts above the workspace. It defaults to
 * zero, which is correct for a page that gives the workspace the whole viewport.
 */
export const workspaceCss = (): string => {
  const root = `.${ROOT_CLASS}`;
  const frame = `.${FRAME_CLASS}`;
  const panes = `.${PANES_CLASS}`;
  const pane = `.${PANE_CLASS}`;
  const replay = `${panes}[${REPLAY_ATTRIBUTE}="true"]`;
  const placed = PANE_ORDER.map((name) => `${pane}--${name} { grid-area: ${name}; }`).join(' ');

  return [
    `${root} { container-type: inline-size; container-name: orrery-grading; }`,
    // STACKED is the default, so a browser without container queries gets the arrangement that works at any width.
    `${panes} { display: grid; gap: 0.75rem; grid-template-columns: minmax(0, 1fr); }`,
    `${pane} { min-inline-size: 0; overflow-wrap: anywhere; }`,

    `@container orrery-grading (min-width: ${String(STACKED_BELOW_PX)}px) {`,
    `  ${frame} { display: flex; flex-direction: column; block-size: calc(100dvh - var(--orrery-grading-offset, 0px)); min-block-size: 30rem; }`,
    `  ${panes} { flex: 1 1 auto; min-block-size: 0; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); grid-template-rows: minmax(0, 1fr) auto; grid-template-areas: ${areasCss(gridAreas('EVIDENCE_OVER_MARKING', false))}; }`,
    `  ${replay} { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) auto; grid-template-areas: ${areasCss(gridAreas('EVIDENCE_OVER_MARKING', true))}; }`,
    `  ${placed}`,
    `  ${pane} { overflow: auto; }`,
    `  ${pane}--marking { max-block-size: ${String(MARKING_MAX_BLOCK_PERCENT)}dvh; }`,
    `  .${STACKED_NOTE_CLASS} { display: none; }`,
    '}',

    `@container orrery-grading (min-width: ${String(SIDE_BY_SIDE_MIN_PX)}px) {`,
    `  ${panes} { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(18rem, 22rem); grid-template-rows: minmax(0, 1fr); grid-template-areas: ${areasCss(gridAreas('SIDE_BY_SIDE', false))}; }`,
    `  ${replay} { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: ${areasCss(gridAreas('SIDE_BY_SIDE', true))}; }`,
    `  ${pane}--marking { max-block-size: none; }`,
    '}',
  ].join('\n');
};
