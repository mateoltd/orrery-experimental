/**
 * The pane arrangement.  (P9-T2)
 *
 * jsdom computes no layout, so nothing here proves the panes are beside each other. What it pins is the DECISION --
 * the two widths at which the arrangement changes -- and that the stylesheet is generated from the same numbers
 * `layoutFor` uses, so the documented thresholds and the shipped ones cannot come apart.
 */

import { describe, expect, it } from 'vitest';

import {
  gridAreas,
  layoutFor,
  MARKING_MAX_BLOCK_PERCENT,
  PANE_ORDER,
  SIDE_BY_SIDE_MIN_PX,
  STACKED_BELOW_PX,
  workspaceCss,
} from './layout';

describe('layoutFor: the decision, at its exact boundaries', () => {
  it('puts three columns side by side from 1280px, which is the laptop case', () => {
    expect(SIDE_BY_SIDE_MIN_PX).toBe(1280);
    expect(layoutFor(1280)).toBe('SIDE_BY_SIDE');
    expect(layoutFor(1920)).toBe('SIDE_BY_SIDE');
  });

  it('keeps question and answer side by side and moves the marking panel beneath, from 800px to 1279px', () => {
    expect(STACKED_BELOW_PX).toBe(800);
    expect(layoutFor(1279)).toBe('EVIDENCE_OVER_MARKING');
    expect(layoutFor(1024)).toBe('EVIDENCE_OVER_MARKING');
    expect(layoutFor(800)).toBe('EVIDENCE_OVER_MARKING');
  });

  it('STACKS below 800px, where the side-by-side guarantee is given up and said to be', () => {
    expect(layoutFor(799)).toBe('STACKED');
    expect(layoutFor(320)).toBe('STACKED');
    expect(layoutFor(0)).toBe('STACKED');
  });
});

describe('gridAreas: what is beside what', () => {
  it('has question and answer in ONE ROW whenever there is no replay, in both non-stacked arrangements', () => {
    expect(gridAreas('SIDE_BY_SIDE', false)).toEqual([['question', 'answer', 'marking']]);
    expect(gridAreas('EVIDENCE_OVER_MARKING', false)[0]).toEqual(['question', 'answer']);
  });

  it('gives the replay a full-height column beside BOTH the question and the answer', () => {
    for (const mode of ['SIDE_BY_SIDE', 'EVIDENCE_OVER_MARKING'] as const) {
      const rows = gridAreas(mode, true);
      expect(rows[0]?.slice(0, 2), mode).toEqual(['question', 'replay']);
      expect(rows[1]?.slice(0, 2), mode).toEqual(['answer', 'replay']);
    }
  });

  it('keeps the question and the answer in ADJACENT cells, with nothing between what is being compared', () => {
    for (const mode of ['SIDE_BY_SIDE', 'EVIDENCE_OVER_MARKING'] as const) {
      for (const hasReplay of [false, true]) {
        const rows = gridAreas(mode, hasReplay);
        const cells = (name: string): readonly (readonly [number, number])[] =>
          rows.flatMap((row, r) =>
            row.flatMap((cell, c) => (cell === name ? [[r, c] as const] : [])),
          );
        const touching = cells('question').some(([qr, qc]) =>
          cells('answer').some(([ar, ac]) => Math.abs(qr - ar) + Math.abs(qc - ac) === 1),
        );
        expect(touching, `${mode} replay=${String(hasReplay)}`).toBe(true);
      }
    }
  });

  it('never sends the tab order up-and-left: each pane starts to the right of, or below, the one before it', () => {
    /**
     * The DOM order is fixed, so the tab order is. What can go wrong is the PLACEMENT: an arrangement that put the
     * answer above the question would have focus jump backwards on screen. Row-major and column-major reading are
     * both in use here (question over answer beside the replay; question beside answer over the marking panel), so
     * the property that holds for both is the one asserted: no step goes back in both directions at once.
     */
    expect(PANE_ORDER).toEqual(['question', 'answer', 'replay', 'marking']);
    for (const mode of ['SIDE_BY_SIDE', 'EVIDENCE_OVER_MARKING'] as const) {
      for (const hasReplay of [false, true]) {
        const rows = gridAreas(mode, hasReplay);
        const origin = (name: string): { row: number; column: number } => {
          for (const [row, cells] of rows.entries()) {
            const column = cells.indexOf(name as (typeof cells)[number]);
            if (column !== -1) return { row, column };
          }
          throw new Error(`${name} is not placed in ${mode}`);
        };
        const present = PANE_ORDER.filter((name) => hasReplay || name !== 'replay');
        for (let index = 1; index < present.length; index += 1) {
          const before = origin(present[index - 1] ?? '');
          const after = origin(present[index] ?? '');
          expect(
            after.row > before.row || after.column > before.column,
            `${mode} replay=${String(hasReplay)}: ${String(present[index - 1])} -> ${String(present[index])}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('workspaceCss: generated from the same numbers', () => {
  const css = workspaceCss();

  it('uses a CONTAINER query at each threshold, so the width is the workspace’s and not the window’s', () => {
    expect(css).toContain(`@container orrery-grading (min-width: ${String(STACKED_BELOW_PX)}px)`);
    expect(css).toContain(
      `@container orrery-grading (min-width: ${String(SIDE_BY_SIDE_MIN_PX)}px)`,
    );
    expect(css).toContain('container-type: inline-size');
    expect(css).not.toContain('@media');
  });

  it('writes each arrangement’s areas from gridAreas, not from a second copy', () => {
    expect(css).toContain('grid-template-areas: "question answer marking"');
    expect(css).toContain('grid-template-areas: "question replay marking" "answer replay marking"');
    expect(css).toContain('grid-template-areas: "question answer" "marking marking"');
    expect(css).toContain(
      'grid-template-areas: "question replay" "answer replay" "marking marking"',
    );
  });

  it('is a single column OUTSIDE any query, so the stacked arrangement is the fallback', () => {
    const beforeFirstQuery = css.slice(0, css.indexOf('@container'));
    expect(beforeFirstQuery).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(beforeFirstQuery).not.toContain('grid-template-areas');
    expect(beforeFirstQuery).not.toContain('overflow: auto');
  });

  it('scrolls each pane on its own once they are side by side, and caps the marking panel beneath', () => {
    expect(css).toContain('overflow: auto');
    expect(css).toContain(`max-block-size: ${String(MARKING_MAX_BLOCK_PERCENT)}dvh`);
  });

  it('hides the "stacked" notice exactly where the panes are no longer stacked', () => {
    const fromFirstQuery = css.slice(css.indexOf('@container'));
    expect(fromFirstQuery).toContain('.orrery-grading__stacked-note { display: none; }');
    expect(css.slice(0, css.indexOf('@container'))).not.toContain('stacked-note');
  });

  it('uses logical properties only, so a right-to-left locale is not laid out backwards', () => {
    expect(css).not.toMatch(/\b(margin|padding)-(left|right)\b/);
    // Declarations only: `(min-width: 800px)` inside a container query is a condition, not a property.
    expect(css).not.toMatch(/[{;]\s*(min-|max-)?(width|height)\s*:/);
  });
});
