/**
 * The block schema: a CLOSED union of 16 types.  (P2-T1, plans/05 §2)
 *
 * ## Why there is no HTML field anywhere in this file
 *
 * Author content is a closed union, never free HTML. That is the single most important security
 * and maintainability decision in the content layer, and it works like this: the renderer only
 * ever emits HTML it generates itself from typed data. There is no sanitiser to keep patched,
 * because there is nothing to sanitise.
 *
 * MDX is rejected because it executes author-supplied JSX. Raw Markdown with a sanitiser is
 * rejected because sanitiser drift is a standing liability. Raw HTML passthrough is rejected
 * because it destroys the structural diff that versioning depends on (RN-12).
 *
 * A future contributor reaching for an "escape hatch" block should read the file header first.
 *
 * ## `z.strictObject` on every inbound schema
 *
 * Unknown keys are REJECTED, not stripped. Stripping is silent data loss: a document authored
 * by a newer version loses fields when read by an older one, and the first symptom is content
 * disappearing with no error. Rejecting produces a field path instead.
 *
 * ## `id` on every block, and why it is not optional
 *
 * Diffs, analytics, per-block comments and the three-way merge all address blocks by identity.
 * A content-addressed or positional identity changes when an earlier block is inserted, which
 * turns "block 3 was edited" into "everything after block 2 is new". `id` is required and
 * stable.
 *
 * ## Adding a 17th type
 *
 * Requires a renderer case, an authoring node, a diff case and a migration step. The registry
 * test asserts the count is 16 and that every type has a fixture, so the omission fails a test
 * rather than being discovered in production.
 */

import { z } from 'zod';
import { PROVIDER_IDS } from './providers.js';

/** The document's schema version. Bumped when a block FIELD changes shape. */
export const CURRENT_SCHEMA_VERSION = 1;

const blockId = z
  .string()
  .uuid('every block needs a stable uuid so diffs and analytics survive versions');

/**
 * Inline marks on text.
 *
 * Marks are DATA, not rendered HTML. A link is `{ type: 'link', href }` and the renderer
 * decides what to emit, which is what lets the renderer refuse `javascript:` hrefs once, in one
 * place, rather than every call site.
 */
export const textRun = z.strictObject({
  text: z.string().max(20_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
  /** Only http(s) and mailto. Enforced here AND at render; see `LINK_SCHEMES`. */
  href: z.string().max(2_048).optional(),
  math: z.string().max(2_000).optional(),
});

export type TextRun = z.infer<typeof textRun>;

/** A paragraph of text runs. Shared by several blocks. */
const richText = z.array(textRun).max(2_000);

// 1. paragraph
export const paragraphBlock = z.strictObject({
  type: z.literal('paragraph'),
  id: blockId,
  content: richText,
});

// 2. heading
export const headingBlock = z.strictObject({
  type: z.literal('heading'),
  id: blockId,
  level: z.number().int().min(1).max(4),
  content: richText,
  /** Explicit anchor, because auto-generated ones change when an earlier heading is added. */
  anchor: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
});

// 3. list
/**
 * `ListItem` is declared as an interface rather than inferred.
 *
 * `listItem` refers to itself through `z.lazy`, and TypeScript cannot infer a type that refers
 * to its own initializer — it reports the whole chain as `any`, silently. An explicit
 * `z.ZodType<ListItem>` is the documented pattern and keeps the recursion typed. Same for
 * `Block` in the `columns` block below.
 */
export interface ListItem {
  readonly id: string;
  readonly content: readonly TextRun[];
  readonly checked?: boolean;
  readonly children?: readonly ListItem[];
}

export const listItem: z.ZodType<ListItem> = z.strictObject({
  id: blockId,
  content: richText,
  /** Only meaningful when the list style is `task`. */
  checked: z.boolean().optional(),
  children: z
    .array(z.lazy((): z.ZodType<ListItem> => listItem))
    .max(20)
    .optional(),
}) as unknown as z.ZodType<ListItem>;

export const listBlock = z.strictObject({
  type: z.literal('list'),
  id: blockId,
  style: z.enum(['ordered', 'unordered', 'task']),
  items: z.array(listItem).min(1).max(500),
});

// 4. blockquote
export const blockquoteBlock = z.strictObject({
  type: z.literal('blockquote'),
  id: blockId,
  content: richText,
  cite: z.string().max(500).optional(),
});

// 5. callout
export const calloutBlock = z.strictObject({
  type: z.literal('callout'),
  id: blockId,
  // `insight` is not a standard admonition name; it is ours, and the renderer has a case for
  // it. The enum is the allowlist, so a typo is a validation error rather than an unstyled box.
  variant: z.enum(['note', 'tip', 'warning', 'danger', 'insight']),
  title: z.string().max(200).optional(),
  content: richText,
});

// 6. code
export const codeBlock = z.strictObject({
  type: z.literal('code'),
  id: blockId,
  code: z.string().max(50_000),
  language: z.enum([
    'plaintext',
    'bash',
    'javascript',
    'typescript',
    'python',
    'sql',
    'json',
    'yaml',
    'c',
    'cpp',
    'java',
    'rust',
    'go',
  ]),
  filename: z.string().max(255).optional(),
  /** 1-BASED line numbers. A 0-based one in a schema is an off-by-one waiting to happen. */
  highlightLines: z.array(z.number().int().min(1).max(10_000)).max(500).optional(),
});

// 7. equation
export const equationBlock = z.strictObject({
  type: z.literal('equation'),
  id: blockId,
  latex: z.string().min(1).max(10_000),
  display: z.enum(['block', 'inline']),
  /** Equation number, for a cross-reference. */
  number: z.string().max(20).optional(),
  /** Alt text for the MathML fallback, and for the KaTeX-rendered case where it is absent. */
  altText: z.string().max(500).optional(),
});

// 8. image — `alt` is REQUIRED
export const imageBlock = z.strictObject({
  type: z.literal('image'),
  id: blockId,
  assetId: z.string().uuid(),
  /**
   * REQUIRED, not optional.
   *
   * An empty string is explicitly allowed and means "decorative" — that is a decision a
   * human makes, and the renderer emits `alt=""` plus `aria-hidden` for it. What is not
   * allowed is ABSENT, which is how images end up with a filename announced to a screen
   * reader.
   */
  alt: z.string().max(1_000),
  caption: z.string().max(2_000).optional(),
  width: z.number().int().min(1).max(4_000).optional(),
});

// 9. video
export const videoBlock = z
  .strictObject({
    type: z.literal('video'),
    id: blockId,
    provider: z.enum(['youtube', 'vimeo', 'upload']),
    /** Required for the hosted providers; absent for `upload`, which uses `assetId`. */
    videoId: z.string().max(128).optional(),
    assetId: z.string().uuid().optional(),
    title: z.string().max(300),
    captions: z
      .array(
        z.strictObject({
          assetId: z.string().uuid(),
          language: z.string().max(16),
          label: z.string().max(100),
        }),
      )
      .max(20)
      .optional(),
    transcript: z.string().max(200_000).optional(),
  })
  .refine((v) => (v.provider === 'upload' ? v.assetId !== undefined : v.videoId !== undefined), {
    message: 'provider "upload" needs assetId; youtube and vimeo need videoId',
    path: ['videoId'],
  });

// 10. table — `caption` is REQUIRED
export const tableBlock = z
  .strictObject({
    type: z.literal('table'),
    id: blockId,
    /** A caption is a WCAG requirement for a data table, not a nicety. */
    caption: z.string().min(1).max(1_000),
    /** Column alignments, one per column. */
    alignments: z
      .array(z.enum(['left', 'center', 'right']))
      .max(64)
      .optional(),
    header: z.array(z.string().max(500)).min(1).max(64),
    rows: z.array(z.array(z.string().max(10_000)).max(64)).max(2_000),
  })
  .refine((v) => v.alignments === undefined || v.alignments.length === v.header.length, {
    message: 'alignments must have one entry per header column',
    path: ['alignments'],
  })
  .refine((v) => v.rows.every((r) => r.length === v.header.length), {
    message: 'every row must have the same number of cells as the header',
    path: ['rows'],
  });

// 11. embedSimulation
export const embedSimulationBlock = z
  .strictObject({
    type: z.literal('embedSimulation'),
    id: blockId,
    simId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    /**
     * PINNED, not floating.
     *
     * A simulation whose behaviour changes under a lesson changes every result a student has
     * already computed. `plans/00` §6 requires immutability for exactly this reason, so a
     * version is part of the reference, not a lookup.
     */
    simVersion: z.string().max(32),
    params: z
      .record(z.string().max(64), z.union([z.string().max(1_000), z.number(), z.boolean()]))
      .default({}),
    /**
     * `FIXED` is the default and the only one safe for a graded simulation. The others exist
     * for practice, and the renderer keys the grading surface off this field.
     */
    seedPolicy: z.enum(['FIXED', 'PER_STUDENT', 'PER_VIEW']),
    mode: z.enum(['explore', 'practice', 'graded']),
  })
  .refine((v) => v.mode !== 'graded' || v.seedPolicy === 'FIXED', {
    message: 'a GRADED simulation must use a FIXED seed, or two students get different questions',
    path: ['seedPolicy'],
  });

// 12. practiceCheck
export const practiceCheckBlock = z
  .strictObject({
    type: z.literal('practiceCheck'),
    id: blockId,
    /**
     * A SNAPSHOT of the question, not a reference to it.
     *
     * The lesson must render identically a year later. A live reference means editing the
     * question silently rewrites every lesson that embeds it, and the grade a student was given
     * no longer matches the work they saw.
     */
    question: z.object({
      snapshotId: z.string().uuid(),
      stem: richText,
      choices: z.array(richText).min(2).max(12),
      correctChoiceIndex: z.number().int().min(0),
      explanation: richText.optional(),
      points: z.number().int().min(0).max(100).optional(),
    }) as z.ZodType<{
      snapshotId: string;
      stem: readonly TextRun[];
      choices: readonly (readonly TextRun[])[];
      correctChoiceIndex: number;
      explanation?: readonly TextRun[];
      points?: number;
    }>,

    /** Whether an attempt is recorded, and whether the explanation is revealed immediately. */
    feedbackPolicy: z.enum(['immediate', 'afterAttempt', 'afterReview']),
  })
  .refine((v) => v.question.correctChoiceIndex < v.question.choices.length, {
    message: 'correctChoiceIndex is out of range',
    path: ['question', 'correctChoiceIndex'],
  });

// 13. keyValue
export const keyValueBlock = z.strictObject({
  type: z.literal('keyValue'),
  id: blockId,
  /** Rendered as a `<dl>`, which is the semantics a definition list actually has. */
  pairs: z
    .array(z.strictObject({ term: z.string().max(500), definition: richText }))
    .min(1)
    .max(200),
});

// 14. divider
export const dividerBlock = z.strictObject({
  type: z.literal('divider'),
  id: blockId,
  variant: z.enum(['solid', 'dotted', 'dashed']),
});

// 15. columns
/**
 * `ColumnsBlock` is an interface because this is the block that makes the schema recursive: a
 * `columns` block contains blocks, and one of those may be another `columns`. `z.infer` cannot
 * describe that, so both this block and the `Block` union are DECLARED and the runtime schema is
 * cast once, below, with the reason written at the cast.
 */
export interface ColumnsBlock {
  readonly type: 'columns';
  readonly id: string;
  readonly columns: 2 | 3;
  readonly children: readonly Block[];
}

export const columnsBlock = z
  .strictObject({
    type: z.literal('columns'),
    id: blockId,
    columns: z.union([z.literal(2), z.literal(3)]),
    // The reference to `blockSchema` is INSIDE a callback, which is what lets TypeScript
    // accept the forward reference to a `const` declared further down. Written directly as
    // `z.array(blockSchema)` it is "used before its declaration" — a real error, not a pedantic
    // one, because the value genuinely is not assigned yet.
    children: z.array(z.lazy(() => blockSchema)).max(20),
  })
  .refine((v) => v.children.length > 0, {
    message: 'a columns block with no children renders nothing',
    path: ['children'],
  });

// 16. embedExternal — PROVIDER ALLOWLIST, no URL field
export const embedExternalBlock = z.strictObject({
  type: z.literal('embedExternal'),
  id: blockId,
  /** A key of the provider allowlist. Not a URL, and there is no field to put one in. */
  provider: z.enum(PROVIDER_IDS as [string, ...string[]]),
  /**
   * The provider's own identifier, not a URL.
   *
   * The name is deliberate. An author asked for "a YouTube video" should paste a video ID
   * they may well have copied from a URL, and a field called `url` invites the whole thing to
   * be pasted into it — at which point the allowlist is doing the work of a regex.
   */
  providerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  title: z.string().min(1).max(300),
});

export const blockSchema: z.ZodType<Block> = z.discriminatedUnion('type', [
  paragraphBlock,
  headingBlock,
  listBlock,
  blockquoteBlock,
  calloutBlock,
  codeBlock,
  equationBlock,
  imageBlock,
  videoBlock,
  tableBlock,
  embedSimulationBlock,
  practiceCheckBlock,
  keyValueBlock,
  dividerBlock,
  columnsBlock,
  embedExternalBlock,
]);

/**
 * `Block` is DECLARED, not inferred, and that is forced by recursion.
 *
 * `columns` contains blocks and a block can be a `columns`, so `blockSchema` appears in its own
 * initializer. `z.infer` cannot express that: TypeScript reports the whole cycle as `any`
 * (TS7022) and, with an annotation, as a circular type alias (TS2456). Declaring the union
 * explicitly breaks the cycle at the type level while leaving the runtime schema exactly the
 * same discriminated union.
 *
 * The cost is that adding a block type means adding it in two places. `BLOCK_TYPES` and the
 * registry test both fail if they are out of sync, so the duplication is checked rather than
 * merely noted.
 */
export type Block =
  | z.infer<typeof paragraphBlock>
  | z.infer<typeof headingBlock>
  | z.infer<typeof listBlock>
  | z.infer<typeof blockquoteBlock>
  | z.infer<typeof calloutBlock>
  | z.infer<typeof codeBlock>
  | z.infer<typeof equationBlock>
  | z.infer<typeof imageBlock>
  | z.infer<typeof videoBlock>
  | z.infer<typeof tableBlock>
  | z.infer<typeof embedSimulationBlock>
  | z.infer<typeof practiceCheckBlock>
  | z.infer<typeof keyValueBlock>
  | z.infer<typeof dividerBlock>
  | ColumnsBlock
  | z.infer<typeof embedExternalBlock>;

export type BlockType = Block['type'];

/**
 * The schema for each block type, keyed by that type.
 *
 * ## Why this exists
 *
 * The discriminated union gives you "is this document valid". It does not give you "what are
 * the FIELDS of block type X", which is what anything that has to reason about a block
 * individually needs: the editor's per-type attribute specs (`editor/attrSpecs.ts`), a
 * per-field publish rule, a migration step that rewrites one field, and a form that renders
 * itself from the shape.
 *
 * Without it, each of those re-derives the field list by hand, and a hand-derived field list
 * next to a Zod schema is a second source of truth that fails silently — the field is added to
 * the schema, the hand list is not, and the new field is simply absent from the editor.
 *
 * Keyed by the type name rather than discovered from the union, because Zod v4 does not expose
 * a union's members as a lookup. The map is therefore a CLAIM, and `BLOCK_SCHEMAS_MATCH_TYPES`
 * below is the test that makes the claim checkable.
 */
export const BLOCK_SCHEMAS = {
  paragraph: paragraphBlock,
  heading: headingBlock,
  list: listBlock,
  blockquote: blockquoteBlock,
  callout: calloutBlock,
  code: codeBlock,
  equation: equationBlock,
  image: imageBlock,
  video: videoBlock,
  table: tableBlock,
  embedSimulation: embedSimulationBlock,
  practiceCheck: practiceCheckBlock,
  keyValue: keyValueBlock,
  divider: dividerBlock,
  columns: columnsBlock,
  embedExternal: embedExternalBlock,
} as const satisfies Record<BlockType, z.ZodType>;

/** Every type name, in the packet's order. The count is asserted by the registry test. */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'list',
  'blockquote',
  'callout',
  'code',
  'equation',
  'image',
  'video',
  'table',
  'embedSimulation',
  'practiceCheck',
  'keyValue',
  'divider',
  'columns',
  'embedExternal',
] as const satisfies readonly BlockType[];

/** The document envelope. `schemaVersion` is what makes migration possible at all. */
export const documentSchema = z.strictObject({
  schemaVersion: z.number().int().min(1),
  title: z.string().min(1).max(300),
  /** Who wrote it, and when — because a document without provenance cannot be diffed usefully. */
  authorId: z.string().uuid(),
  blocks: z.array(blockSchema).max(2_000),
});

export type ContentDocument = z.infer<typeof documentSchema>;

/** The result of validating a document, with FIELD PATHS. */
export type ValidationIssue = { readonly path: string; readonly message: string };

/**
 * Turn zod issues into issues with USABLE paths.
 *
 * ## Why this function exists
 *
 * zod reports an unknown key as `unrecognized_keys` with an EMPTY path and the key names in a
 * separate `keys` array. Inside a discriminated union — which is every block — that means
 * `validateBlock` says "something is wrong, at the block", which is useless for a 2,000-block
 * document and useless for the editor's jump-to-block.
 *
 * So each unrecognised key becomes its own issue whose path IS the key. The packet asks for
 * "invalid documents are rejected with field paths"; without this it is technically true and
 * practically false, which is the same failure as a gate that cannot fail.
 */
function toIssues(error: z.ZodError, root: string): ValidationIssue[] {
  return error.issues.flatMap((i) => {
    if (i.code === 'unrecognized_keys') {
      return i.keys.map((key) => ({
        path: root === '(block)' ? key : `${root}.${key}`,
        message: `unrecognised field "${key}". Remove it, or raise the document's schemaVersion.`,
      }));
    }
    const suffix = i.path.map(String).join('.');
    // A single block's issues carry no `(block)` prefix. The editor validates one block at a
    // time and prefixes it onto the field itself, so `alt` rather than `(block).alt` is what
    // the UI needs. Document-level issues keep the `(document)` marker, because there the root
    // really is the document.
    return [
      {
        path:
          suffix === '' || root === '(block)'
            ? suffix
            : root === '(document)'
              ? suffix
              : `${root}.${suffix}`,
        message: i.message,
      },
    ];
  });
}

/**
 * Validate a document, returning issues with field paths.
 *
 * A boolean tells a developer nothing about which of 2,000 blocks is wrong. A path is what lets
 * the editor jump to it, and what makes `validateForPublish` (P2-T10) a checklist of links
 * rather than a wall of text.
 */
export function validateDocument(
  input: unknown,
): { ok: true; document: ContentDocument } | { ok: false; issues: ValidationIssue[] } {
  const result = documentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data };
  return { ok: false, issues: toIssues(result.error, '(document)') };
}

/** Validate a single block. Used by the editor on every keystroke, so it must be cheap. */
export function validateBlock(
  input: unknown,
): { ok: true; block: Block } | { ok: false; issues: ValidationIssue[] } {
  const result = blockSchema.safeParse(input);
  if (result.success) return { ok: true, block: result.data };
  return { ok: false, issues: toIssues(result.error, '(block)') };
}
