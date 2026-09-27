/**
 * The slash-command palette's matching.  (P2-T3c)
 *
 * ## Keywords, because authors type words, not type names
 *
 * An author typing `/bullet` wants a list. `/quote` wants a blockquote. `/tide` wants the
 * simulation. A palette that only matches its own identifiers looks broken to everyone who has
 * not read the schema, so each entry carries the words somebody would actually type.
 *
 * ## Ranking, and why the label beats a keyword
 *
 * Prefix beats substring, and the LABEL beats any keyword. So `list` offers List first, and
 * `bullet` still finds it. A palette that ranks by insertion order instead is a palette where
 * typing three letters makes the right answer the fourth item, and the author learns to type the
 * whole word.
 *
 * An empty query returns everything, in declaration order, which is a usable browse -- and the
 * React layer refuses to insert on an empty query regardless, because `/` followed by Enter must
 * not silently create a heading for somebody who was trying to divide something.
 */

import { BLOCK_TYPES, type BlockType } from '../blocks/index.js';

export interface PaletteEntry {
  readonly type: BlockType;
  readonly label: string;
  readonly hint: string;
  readonly keywords: readonly string[];
}

export const PALETTE: readonly PaletteEntry[] = [
  { type: 'paragraph', label: 'Text', hint: 'A paragraph', keywords: ['text', 'body'] },
  { type: 'heading', label: 'Heading', hint: 'A section title', keywords: ['title', 'section'] },
  {
    type: 'list',
    label: 'List',
    hint: 'Bulleted, numbered or a checklist',
    keywords: ['bullet', 'bullets', 'numbered', 'todo', 'task', 'checklist'],
  },
  {
    type: 'blockquote',
    label: 'Quote',
    hint: 'Something someone said',
    keywords: ['quote', 'cite'],
  },
  {
    type: 'callout',
    label: 'Callout',
    hint: 'A highlighted note',
    keywords: ['note', 'tip', 'warning', 'insight', 'box'],
  },
  { type: 'code', label: 'Code', hint: 'A code sample', keywords: ['code', 'snippet', 'program'] },
  {
    type: 'equation',
    label: 'Equation',
    hint: 'Maths, in LaTeX',
    keywords: ['equation', 'maths', 'math', 'latex', 'formula'],
  },
  {
    type: 'image',
    label: 'Image',
    hint: 'A picture, with alt text',
    keywords: ['image', 'picture', 'photo', 'figure', 'diagram'],
  },
  {
    type: 'video',
    label: 'Video',
    hint: 'A video, with captions',
    keywords: ['video', 'film', 'clip'],
  },
  { type: 'table', label: 'Table', hint: 'Rows and columns', keywords: ['table', 'grid', 'data'] },
  {
    type: 'embedSimulation',
    label: 'Simulation',
    hint: 'An interactive model',
    keywords: ['simulation', 'sim', 'interactive', 'model', 'tide', 'orbit'],
  },
  {
    type: 'practiceCheck',
    label: 'Question',
    hint: 'A multiple-choice check',
    keywords: ['question', 'quiz', 'check', 'practice'],
  },
  {
    type: 'keyValue',
    label: 'Definitions',
    hint: 'Terms and meanings',
    keywords: ['definition', 'glossary', 'terms', 'vocabulary'],
  },
  {
    type: 'divider',
    label: 'Divider',
    hint: 'A horizontal rule',
    keywords: ['divider', 'rule', 'line', 'break'],
  },
  {
    type: 'embedExternal',
    label: 'Embed',
    hint: 'A video from a supported provider',
    keywords: ['embed', 'iframe', 'external'],
  },
  {
    type: 'columns',
    label: 'Columns',
    hint: 'Two or three side by side',
    keywords: ['columns', 'column', 'side', 'layout'],
  },
];

const SCORE_LABEL_PREFIX = 3;
const SCORE_TYPE_PREFIX = 2;
const SCORE_KEYWORD_PREFIX = 1;
const SCORE_SUBSTRING = 0;

function score(entry: PaletteEntry, q: string): number {
  const label = entry.label.toLowerCase();
  if (label.startsWith(q)) return SCORE_LABEL_PREFIX;
  if (entry.type.toLowerCase().startsWith(q)) return SCORE_TYPE_PREFIX;
  for (const k of entry.keywords) {
    if (k.toLowerCase().startsWith(q)) return SCORE_KEYWORD_PREFIX;
  }
  // Substring last, and only on keywords and the label -- a type name is a compound like
  // `embedSimulation`, where a substring match on "sim" landing on `embedSimulation` is a
  // feature, but on `embedExternal` it is noise.
  if (label.includes(q)) return SCORE_SUBSTRING;
  for (const k of entry.keywords) if (k.toLowerCase().includes(q)) return SCORE_SUBSTRING;
  return -1;
}

export function searchPalette(query: string): readonly PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return PALETTE;
  return (
    PALETTE.map((entry, i) => ({ entry, i, s: score(entry, q) }))
      .filter((x) => x.s >= 0)
      // Score DESC, then declaration order, so equally-scored matches stay in a predictable order
      // rather than shuffling on every keystroke — an author arrowing down should not have the
      // list reshuffle under them as they type.
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.entry)
  );
}

/**
 * Does the slash command apply here?
 *
 * The rule is: the text from the start of the line to the caret, trimmed, BEGINS with `/`.
 *
 * ## Why "begins with" and not "ends with"
 *
 * The first version checked that the text ended with `/`, which is true for exactly one
 * keystroke -- the moment the slash is typed. The palette then closed on the very next character,
 * so it could never be filtered: type `/`, see sixteen blocks, type `t`, and the list vanishes.
 *
 * The "begins with" form is both the useful one and the only one that survives being derived from
 * the text on every render, which is how the open state is computed (see `SlashPalette`). A
 * slash in the middle of a sentence is a slash: `3/4` and `and/or` must not open a palette over
 * somebody's half-written prose.
 */
export function shouldOpenPalette(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  return line.trimStart().startsWith('/');
}

/**
 * The query typed after the slash, or `null` when no command is open.
 *
 * Returned rather than sliced at the call site, because the two must agree about where the line
 * starts: computing the query one way and the open-state another is how a palette ends up
 * filtering on the wrong text.
 */
export function paletteQuery(text: string, caret: number): string | null {
  if (!shouldOpenPalette(text, caret)) return null;
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart).trimStart();
  return line.slice(line.indexOf('/') + 1);
}

/** Remove the `/query` the author typed, leaving the text either side intact. */
export function stripCommand(text: string, caret: number, length: number): string {
  const before = text.slice(0, caret - length - 1);
  const after = text.slice(caret);
  return `${before}${after}`;
}

/** The palette covers every block type, and nothing else. */
export const PALETTE_COVERS_EVERY_TYPE: boolean =
  PALETTE.length === BLOCK_TYPES.length &&
  BLOCK_TYPES.every((t) => PALETTE.some((e) => e.type === t));
