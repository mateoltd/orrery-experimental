/**
 * The editor-representation converter.  (P2-T3a)
 *
 * ## What this is
 *
 * The measured answer to the P2-T3 risk question. Our blocks are FLAT — every field is a
 * sibling of `type`. A ProseMirror node is NESTED — every field lives under one `attrs` object.
 * The two are not the same shape, so a converter is mandatory in both directions, and `attrs` is
 * an unrecognised key under `z.strictObject`, which means a straight pass-through of editor JSON
 * into `blockSchema` fails on 100% of blocks, every time.
 *
 * ## Why it does not import ProseMirror
 *
 * Because it must be testable, and because it is needed under EITHER outcome of the kill-switch.
 * `@orrery/contracts` is a server-side dependency and adding `prosemirror-model` to it would put
 * an editor library on the path of every API request. So this module treats the editor's shape
 * as a *documented structural convention* — `{ type, attrs }` — and maps it with no dependency at
 * all. If TipTap is adopted, this feeds `Node.fromJSON`; if the switch fires, the same functions
 * remain the guarantee that a document written by one editor is readable by the next.
 *
 * ## The null trap, and the whole reason this module exists
 *
 * A ProseMirror attr declared without a `validate` accepts `undefined` and yields `null`,
 * SILENTLY. The measured output for a fully-required block is:
 *
 *     { "type": "embedSimulation", "attrs": { "id": null, "simId": null, "mode": null, ... } }
 *
 * Our schema REQUIRES `mode` and puts a regex on `simId`, and ProseMirror knows nothing about
 * either. So without a defensive step here, an editor round trip can quietly turn a required
 * field into `null` and store it — and the resulting document fails validation only later, at
 * publish time, in front of the teacher rather than in front of the person who caused it.
 *
 * `fromEditorNode` therefore validates on the way back IN, names the block and the field in its
 * error, and never lets a `null` through. That is the whole job.
 */

import { type Block, blockSchema } from '../blocks/index.js';

// Re-exported rather than given its own entry point: the canonical checksum and the converter
// are the SAME boundary seen from two ends -- one hashes what we store, the other reshapes it
// for an editor. Two import paths into one folder is one more thing to wire up wrong.
export { canonicalJson, contentChecksum } from './canonical.js';

/** The editor's node shape. Structural, and deliberately not typed as a ProseMirror type. */
export interface EditorNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

/** The names of the 16 block types, derived from the union rather than restated. */
const KNOWN_TYPES = [
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
  'embedExternal',
  'columns',
] as const;

export type KnownType = (typeof KNOWN_TYPES)[number];

export const isKnownType = (t: string): t is KnownType =>
  (KNOWN_TYPES as readonly string[]).includes(t);

/**
 * Our block → the editor's node.
 *
 * Flat to nested, and **lossless by construction**: the block's own keys minus `type` become the
 * attrs, so there is no field list to fall out of date. A hand-written per-type mapping would be
 * 16 places to forget, and forgetting one is silent.
 */
export function toEditorNode(block: Block): EditorNode {
  const { type, ...attrs } = block as Block & Record<string, unknown>;
  return { type, attrs };
}

export type DecodeFailure = {
  readonly ok: false;
  /** Names the block TYPE and the FIELD, because "invalid document" is not actionable. */
  readonly message: string;
  readonly field: string | null;
};

export type DecodeResult = { readonly ok: true; readonly block: Block } | DecodeFailure;

/**
 * The editor's node → our block, validated.
 *
 * ## Why the null check is explicit rather than left to Zod
 *
 * Because Zod's message for `mode: null` on a required enum is accurate and useless: it says the
 * value is not one of the options, which is true, and it does not say the value arrived as
 * `null` from a layer that defaulted it. The person fixing this is an author looking at a
 * checklist, so the message has to name the block and the field and say where the null came from.
 */
export function fromEditorNode(node: unknown): DecodeResult {
  if (typeof node !== 'object' || node === null) {
    return { ok: false, message: 'not a node at all', field: null };
  }
  const { type, attrs, ...rest } = node as EditorNode & Record<string, unknown>;
  if (typeof type !== 'string') {
    return { ok: false, message: 'a node with no type', field: null };
  }
  if (!isKnownType(type)) {
    // An unknown type is a hard failure, never a passthrough. `plans/14` rests the content-XSS
    // argument on the union being CLOSED, and a permissive branch here would reopen it from the
    // one direction nobody tests: an editor plugin that registered a node we do not know about.
    return { ok: false, message: `unknown block type "${type}"`, field: 'type' };
  }

  // Anything outside `attrs` on the node itself is an editor-side addition. Reject rather than
  // drop: silently discarding a field is how a value gets lost, and a lost value is a resource
  // that renders differently than the author saw.
  const strays = Object.keys(rest);
  if (strays.length > 0) {
    return {
      ok: false,
      message: `the editor put ${strays.join(', ')} on the node itself, outside attrs`,
      field: strays[0] ?? null,
    };
  }

  const flat: Record<string, unknown> = { type, ...(attrs ?? {}) };

  // THE NULL TRAP. A `null` here is almost always an attr ProseMirror defaulted because it had
  // no `validate`, and it is never a value an author chose: our union has no nullable fields at
  // the top level of a block, and every one of them is required or optional-with-a-default.
  for (const [key, value] of Object.entries(flat)) {
    if (value !== null) continue;
    return {
      ok: false,
      message:
        `"${type}.${key}" arrived as null, which means the editor declared it without a ` +
        `validator and defaulted it. It is not a value an author can fix in the document.`,
      field: key,
    };
  }

  const parsed = blockSchema.safeParse(flat);
  if (parsed.success) return { ok: true, block: parsed.data };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    message: first ? `${type}: ${first.message}` : `${type} is not a valid block`,
    field: first?.path[0] === undefined ? null : String(first.path[0]),
  };
}

/** Decode a whole document, reporting EVERY failure rather than the first. */
export function decodeDocument(nodes: readonly unknown[]): {
  readonly ok: boolean;
  readonly blocks: Block[];
  readonly failures: readonly DecodeFailure[];
} {
  const blocks: Block[] = [];
  const failures: DecodeFailure[] = [];
  nodes.forEach((node, index) => {
    const result = fromEditorNode(node);
    if (result.ok) blocks.push(result.block);
    else failures.push({ ...result, message: `block ${index + 1}: ${result.message}` });
  });
  return { ok: failures.length === 0, blocks, failures };
}

export const KNOWN_BLOCK_TYPES = KNOWN_TYPES;
