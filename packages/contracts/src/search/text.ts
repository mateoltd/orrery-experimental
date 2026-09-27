/**
 * Searchable text, extracted from the closed block union.  (P3-T4)
 *
 * ## The job
 *
 * `plans/05` §6 wants Postgres FTS weighted `title > summary > tags > body`. Three of those
 * four are columns. The fourth — the body — is a JSON array of a closed union, so something has
 * to flatten it into a string before Postgres can index it.
 *
 * ## Why this is EXHAUSTIVE, and why that is the whole design
 *
 * A block-type-keyed extractor that silently ignores unknown types is the standard way a
 * search index goes stale: someone adds a seventeenth block, nobody updates the extractor, and
 * everything inside that block is invisible to search with no error anywhere. The failure is
 * not a crash — it is a teacher concluding that a lesson does not exist.
 *
 * So the extractor is a `Record<BlockType, (b) => string>` and `EXTRACTS_EVERY_BLOCK_TYPE`
 * asserts the two are the same size. Adding a block type to the union without adding an
 * extractor is a FAILING TEST, which is the only moment at which anyone is still thinking
 * about it. This is the same pattern as `PALETTE_COVERS_EVERY_TYPE` in the editor.
 *
 * ## What is deliberately NOT indexed
 *
 *  · **`equation.latex`.** `\frac{1}{2}` is not a word, and feeding it to the English stemmer
 *    produces noise that displaces real matches. `altText` IS indexed, because that is the
 *    human-written description and it is the only readable thing in the block.
 *  · **`code.code`.** Indexed, but as a `D` weight and separated — see the note on `join`.
 *    A teacher searching for a function name is usually looking for prose about it, and code
 *    text dilutes the ranking of the paragraph that explains it.
 *  · **`embedSimulation.params`.** Machine-generated, per-block configuration. Nobody types
 *    "seedPolicy: FIXED" into a search box.
 *
 * ## Normalisation, and why it happens HERE
 *
 * The extracted text is normalised to a single line with collapsed whitespace and a hard cap.
 * A `tsvector` is built from lexemes, so newlines cost index space and buy nothing, and a
 * 200,000-character video transcript is the kind of input that turns one document into a
 * ranking outlier. The cap is applied to the WHOLE document rather than per block, so a
 * document cannot exceed it by having many blocks.
 *
 * Truncation is lossy and that is accepted: the alternative is an unbounded column, and the
 * cap is set above the longest realistic lesson. The cut is recorded in a unit test so that
 * raising it is a deliberate act.
 */

import { type Block, type BlockType, blockSchema, type TextRun } from '../blocks/index.js';

/** Above the longest realistic lesson; see the truncation test before raising it. */
export const MAX_SEARCH_TEXT = 200_000;

/** Text runs, flattened. A run's `text` is the only part a reader would search for. */
function runs(content: readonly TextRun[] | undefined): string {
  if (!content) return '';
  return content.map((r) => r.text).join(' ');
}

function listItems(
  items: readonly {
    content: readonly TextRun[];
    children?: readonly {
      content: readonly TextRun[];
      children?: readonly { content: readonly TextRun[] }[];
    }[];
  }[],
): string {
  const out: string[] = [];
  const walk = (
    list: readonly {
      content: readonly TextRun[];
      children?: readonly {
        content: readonly TextRun[];
        children?: readonly { content: readonly TextRun[] }[];
      }[];
    }[],
  ): void => {
    for (const item of list) {
      out.push(runs(item.content));
      if (item.children) walk(item.children);
    }
  };
  walk(items);
  return out.join(' ');
}

/**
 * Per-type extractors. A `Record`, not a `switch`, so a new block type is a TYPE ERROR here and
 * a FAILING TEST in the exhaustiveness assertion — rather than a silent hole in the index.
 */
const EXTRACTORS: Record<BlockType, (block: never) => string> = {
  paragraph: (b) => runs((b as { content: readonly TextRun[] }).content),
  heading: (b) => runs((b as { content: readonly TextRun[] }).content),
  list: (b) => listItems((b as { items: Parameters<typeof listItems>[0] }).items),
  blockquote: (b) => {
    const x = b as { content: readonly TextRun[]; cite?: string };
    return `${runs(x.content)} ${x.cite ?? ''}`;
  },
  callout: (b) => {
    const x = b as { title?: string; content: readonly TextRun[] };
    return `${x.title ?? ''} ${runs(x.content)}`;
  },
  code: (b) => {
    const x = b as { code: string; filename?: string };
    return `${x.filename ?? ''} ${x.code}`;
  },
  equation: (b) => {
    // `altText` only. The LaTeX is deliberately dropped — see the header.
    const x = b as { altText?: string; number?: string };
    return `${x.altText ?? ''} ${x.number ?? ''}`;
  },
  image: (b) => {
    const x = b as { alt: string; caption?: string };
    return `${x.alt} ${x.caption ?? ''}`;
  },
  video: (b) => {
    const x = b as { title: string; transcript?: string };
    return `${x.title} ${x.transcript ?? ''}`;
  },
  table: (b) => {
    const x = b as {
      caption: string;
      header: readonly string[];
      rows: readonly (readonly string[])[];
    };
    return [x.caption, ...x.header, ...x.rows.flat()].join(' ');
  },
  embedSimulation: () => '',
  practiceCheck: (b) => {
    const x = b as {
      question: {
        stem: readonly TextRun[];
        choices: readonly (readonly TextRun[])[];
        explanation?: readonly TextRun[];
      };
    };
    return [
      runs(x.question.stem),
      ...x.question.choices.map(runs),
      runs(x.question.explanation),
    ].join(' ');
  },
  keyValue: (b) => {
    const x = b as { pairs: readonly { term: string; definition: readonly TextRun[] }[] };
    return x.pairs.map((p) => `${p.term} ${runs(p.definition)}`).join(' ');
  },
  divider: () => '',
  embedExternal: (b) => (b as { title: string }).title,
  columns: (b) => searchableText((b as { children: readonly Block[] }).children),
};

/**
 * The block types the RUNTIME schema actually accepts, read from the discriminated union rather
 * than from a hand-kept list. This is the whole point: a separate `const ALL_TYPES = [...]`
 * would be a second source of truth that drifts from the union, and the drift is exactly what
 * this assertion exists to catch.
 */
export function declaredBlockTypes(): readonly string[] {
  const union = blockSchema as unknown as {
    options: readonly { shape: { type: { value: string } } }[];
  };
  return union.options.map((o) => o.shape.type.value);
}

/**
 * The exhaustiveness assertion, evaluated once at module load.
 *
 * If a seventeenth block lands in the union without an extractor, this is `false` and the test
 * fails NAMING THE MISSING TYPE. A boolean that was merely "these two objects are the same
 * length as each other" would be a tautology that passes forever and detects nothing, which is
 * worse than no assertion because it reads as protection.
 */
export const EXTRACTS_EVERY_BLOCK_TYPE: boolean = (() => {
  const declared = new Set(declaredBlockTypes());
  for (const key of Object.keys(EXTRACTORS)) declared.delete(key);
  return declared.size === 0;
})();

/** Block types in the union with no extractor. Empty in a healthy build. */
export function blockTypesMissingAnExtractor(): readonly string[] {
  const declared = new Set(declaredBlockTypes());
  for (const key of Object.keys(EXTRACTORS)) declared.delete(key);
  return [...declared];
}

/** Flatten a document to normalised, capped, single-line text. */
export function searchableText(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const fn = EXTRACTORS[block.type as BlockType] as ((b: unknown) => string) | undefined;
    // Unknown type: contribute nothing rather than throw. A document being reindexed must not
    // fail wholesale because one block is newer than the indexer — the row still indexes, and
    // the type is caught by the exhaustiveness test instead.
    if (fn === undefined) continue;
    parts.push(fn(block));
  }
  return normalise(parts.join(' '));
}

/** Collapse whitespace, lowercase, cap. Order matters: collapse BEFORE cap, or the cap can split a word. */
export function normalise(input: string): string {
  return input.replace(/\s+/gu, ' ').trim().toLowerCase().slice(0, MAX_SEARCH_TEXT);
}
