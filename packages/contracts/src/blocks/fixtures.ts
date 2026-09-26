/**
 * The fixture corpus.  (P2-T1b do-2)
 *
 * Every historical block shape, committed. The corpus is the thing that makes data loss a TEST
 * FAILURE rather than a user's lesson: a migration that drops a field fails here, on a fixture,
 * in CI — not in month 18 on a year-9 student's homework.
 *
 * ## It is a TypeScript module, not JSON
 *
 * Because the entries must be typed against the schema for their version, and a JSON file
 * cannot be. A corpus that is `unknown[]` would accept a fixture that was never valid, which
 * means it would not prove the migration handles anything real.
 *
 * ## Every entry must round-trip
 *
 * `forward → back → assert the original`. A one-way migration cannot be tested that way, so a
 * one-way migration is not testable and therefore not safe. The corpus test is the only thing
 * that makes the `down` half of each step real.
 */

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (text: string) => [{ text }];
const ASSET = id(900);
const SNAPSHOT = id(901);

/** A fixture: a named set of blocks at a known schema version. */
export interface Fixture {
  readonly name: string;
  readonly schemaVersion: number;
  /** Why this shape existed. A fixture with no note is one nobody will trust in a review. */
  readonly note: string;
  /**
   * `unknown`, NOT `Block`.
   *
   * A v1 fixture is a HISTORICAL shape and does not typecheck against the current schema — that
   * is the entire point of a corpus. Typing the blocks as `Block` would make the most
   * important fixtures impossible to write, and typing them as `any` would let a fixture that
   * was never valid pass silently.
   *
   * The meaningful check is therefore not "valid at its own version" (which nothing can
   * validate, because the old schema no longer exists) but "VALID AFTER MIGRATION TO CURRENT",
   * which is the property that actually matters and which the corpus test asserts.
   */
  readonly blocks: readonly unknown[];
}

/**
 * Version 1 — the shapes as first shipped.
 *
 * `equation.display` is a BOOLEAN here, which is exactly what makes it a useful fixture: it is
 * the one shape the registered 1→2 step exists to rewrite, and a boolean field is the case a
 * migration framework most often gets wrong by assuming a rename rather than a conversion.
 */
export const V1_CORPUS: readonly Fixture[] = [
  {
    name: 'v1-minimal',
    schemaVersion: 1,
    note: 'The smallest document the editor could produce. A corpus with no trivial case proves nothing.',
    blocks: [{ type: 'paragraph', id: id(1), content: run('Orbits are Keplerian ellipses.') }],
  },
  {
    name: 'v1-equation-display-true',
    schemaVersion: 1,
    note: 'The boolean the 1→2 step rewrites. `true` becomes `display: "block"`.',
    blocks: [{ type: 'equation', id: id(2), latex: 'E = mc^2', display: true, number: '1' }],
  },
  {
    name: 'v1-equation-display-false',
    schemaVersion: 1,
    note: '`false` becomes `display: "inline"`. A migration that only handles the truthy case loses this one.',
    blocks: [{ type: 'equation', id: id(2), latex: 'a^2 + b^2 = c^2', display: false }],
  },
  {
    name: 'v1-every-block-type',
    schemaVersion: 1,
    note:
      'One document containing all 16 types at v1. The point of a corpus is breadth: a migration ' +
      'that handles the common blocks and quietly mangles the rare one passes every other test.',
    blocks: [
      {
        type: 'paragraph',
        id: id(1),
        content: [{ text: 'bold', bold: true }, { text: ' and ' }, { text: 'code', code: true }],
      },
      { type: 'heading', id: id(2), level: 2, content: run('Section'), anchor: 'section' },
      { type: 'list', id: id(3), style: 'ordered', items: [{ id: id(4), content: run('first') }] },
      { type: 'blockquote', id: id(5), content: run('quoted'), cite: 'Someone' },
      { type: 'callout', id: id(6), variant: 'warning', title: 'Careful', content: run('body') },
      { type: 'code', id: id(7), code: 'SELECT 1;', language: 'sql', highlightLines: [1] },
      { type: 'equation', id: id(8), latex: '\\frac{1}{2}', display: true },
      { type: 'image', id: id(9), assetId: ASSET, alt: 'An orbit diagram', caption: 'Figure 1' },
      { type: 'video', id: id(10), provider: 'youtube', videoId: 'abc123', title: 'A video' },
      {
        type: 'table',
        id: id(11),
        caption: 'Results',
        header: ['a', 'b'],
        rows: [['1', '2']],
        alignments: ['left', 'right'],
      },
      {
        type: 'embedSimulation',
        id: id(12),
        simId: 'orbit',
        simVersion: '2',
        params: {},
        mode: 'graded',
        seedPolicy: 'FIXED',
      },
      {
        type: 'practiceCheck',
        id: id(13),
        feedbackPolicy: 'immediate',
        question: {
          snapshotId: SNAPSHOT,
          stem: run('2+2?'),
          choices: [run('3'), run('4')],
          correctChoiceIndex: 1,
        },
      },
      {
        type: 'keyValue',
        id: id(14),
        pairs: [{ term: 'AU', definition: run('Astronomical Unit') }],
      },
      { type: 'divider', id: id(15), variant: 'solid' },
      {
        type: 'columns',
        id: id(16),
        columns: 2,
        children: [{ type: 'paragraph', id: id(17), content: run('left') }],
      },
      {
        type: 'embedExternal',
        id: id(18),
        provider: 'vimeo',
        providerId: '12345',
        title: 'A talk',
      },
    ],
  },
  {
    name: 'v1-nested-columns',
    schemaVersion: 1,
    note:
      'Columns inside columns. The recursion is the case a naive `blocks.map(migrate)` gets ' +
      'wrong, because it only rewrites the top level and leaves the children at the old shape.',
    blocks: [
      {
        type: 'columns',
        id: id(20),
        columns: 2,
        children: [
          {
            type: 'columns',
            id: id(21),
            columns: 3,
            children: [{ type: 'equation', id: id(22), latex: 'x^2', display: true }],
          },
        ],
      },
    ],
  },
  {
    name: 'v1-empty',
    schemaVersion: 1,
    note: 'A lesson in progress. A migration that assumes at least one block fails here.',
    blocks: [],
  },
];

/** Version 2 — after the registered step. */
export const V2_CORPUS: readonly Fixture[] = [
  {
    name: 'v2-equation-display-block',
    schemaVersion: 2,
    note: 'The migrated form of the boolean. A corpus needs a current-version entry too, or the round-trip has nothing to return to.',
    blocks: [{ type: 'equation', id: id(2), latex: 'E = mc^2', display: 'block', number: '1' }],
  },
];

export const CORPUS: readonly Fixture[] = [...V1_CORPUS, ...V2_CORPUS];
