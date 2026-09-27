/**
 * ProseMirror attribute specs, derived from the block schema.  (P2-T3b)
 *
 * ## This closes the measured blocker, by construction rather than by detection
 *
 * The P2-T3a probe found that a ProseMirror attr declared with neither `validate` nor
 * `default` accepts `undefined` and yields `null` SILENTLY. That is a trap in the *declaration*,
 * so the fix belongs in the declaration: every attr this module produces carries a `validate`,
 * and that `validate` is the field's OWN Zod schema rather than a predicate re-implemented from
 * it.
 *
 * Re-implementing the checks would be the obvious mistake and it is worth saying why it is
 * wrong. `simId` has a regex, `id` has a uuid format, `params` has a default, `mode` is an enum
 * of three. Each of those becomes a hand-written predicate that can drift from the schema, and a
 * drifted predicate is the worst kind of bug here: it lets through exactly the values the schema
 * exists to reject, in the one layer nobody tests, on the way into stored content.
 *
 * So the `validate` is `(v) => field.safeParse(v).success` — the schema is the authority, and
 * the predicate is a one-liner that cannot disagree with it.
 *
 * ## The invariant this module asserts about itself
 *
 * `attrsFor(type)` returns a spec where **every key has `validate` or `default`, and never
 * neither.** `NO_UNGUARDED_ATTRS` is the test, and it runs over all 16 types — because a single
 * unguarded attr anywhere is the whole bug, and checking the one type you happened to look at is
 * how it survives.
 *
 * ## This is also the answer to "16 types, one hand-written mapping?"
 *
 * `converter.ts` needs the field list per type. Deriving it from the schema means a new block
 * type gets working editor attributes by being added to the schema, and `BLOCK_SCHEMAS` is
 * already proven total against the union.
 */

import type { z } from 'zod';
import { BLOCK_SCHEMAS, type BlockType } from '../blocks/index.js';

/**
 * The ProseMirror attr spec shape, without importing `prosemirror-model`.
 *
 * Declared structurally for the same reason the converter is: `@orrery/contracts` is a
 * server-side dependency, and pulling an editor library into it would put ProseMirror on the
 * path of every API request. This is the subset of `AttrSpec` that matters, and it is
 * structurally compatible with the real one.
 */
export interface AttrSpec {
  readonly default?: unknown;
  readonly validate?: (value: unknown) => boolean;
}

/** The shape a Zod v4 object exposes, narrowed to what this module reads. */
interface ZodDef {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
}

const defOf = (schema: z.ZodType): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def;

/**
 * The fields of a block type, minus `type`.
 *
 * `type` is excluded because it is the ProseMirror node's own discriminant, not an attribute —
 * declaring it as an attr as well would give the same value two homes.
 */
export function fieldsFor(type: BlockType): Record<string, z.ZodType> {
  const shape = defOf(BLOCK_SCHEMAS[type]).shape;
  if (shape === undefined) {
    // Every block type is a `z.strictObject` or a refined one, so this is unreachable. Throwing
    // is right: a silent `{}` would produce a block type with no attributes at all, which looks
    // like a valid empty block rather than a missing schema.
    throw new Error(
      `block type "${type}" has no object shape; the schema is not what this module expects`,
    );
  }
  const { type: _discriminant, ...rest } = shape;
  return rest;
}

/**
 * The `validate` for one field: the field's own schema, asked whether this value is acceptable.
 *
 * Note what this does NOT do: it does not attempt to describe the constraint in the predicate.
 * A comment is not a check, and a second description of a rule is a second rule to forget.
 */
function validateFor(field: z.ZodType): (value: unknown) => boolean {
  return (value: unknown) => field.safeParse(value).success;
}

/**
 * Whether a field declares a default.
 *
 * Read from the schema because a default is a real part of the field's contract — `params`
 * defaults to `{}` and `alignments` is optional — and a spec that guesses wrong here produces a
 * block that validates in the editor and fails on save.
 */
function defaultFor(field: z.ZodType): { hasDefault: boolean; inner?: z.ZodType } {
  const inner = field as unknown as {
    _zod: { def: ZodDef & { innerType?: ZodDef; defaultValue?: unknown; hasDefault?: boolean } };
  };
  const def = inner._zod.def;
  if (def.type === 'default') {
    const innerType = def.innerType;
    // A `.default()` wraps the real schema; validating against the wrapper would accept
    // `undefined`, which is exactly the value an attr must not silently accept.
    // Unwrap. A `.default()` wrapping the real schema is the common case (`params`), and
    // validating against the wrapper would accept `undefined` — the exact value an attr must
    // not silently accept.
    return { hasDefault: true, inner: innerType as unknown as z.ZodType };
  }
  if (def.hasDefault === true) return { hasDefault: true, inner: field };
  return { hasDefault: false };
}

/**
 * Every field becomes an attr with a `validate`, and optionally a `default`.
 *
 * ## Why the default is applied through the inner schema
 *
 * `z.record(...).default({})` is a `default` wrapping a `record`. If the attr's `validate` is the
 * WRAPPER, then `validate(undefined)` is true, and ProseMirror will happily store `undefined` for
 * a field the union requires. The inner schema is the one that says "a record, or not a record".
 */
export function attrsFor(type: BlockType): Record<string, AttrSpec> {
  const fields = fieldsFor(type);
  const out: Record<string, AttrSpec> = {};
  for (const [name, field] of Object.entries(fields)) {
    const { hasDefault, schema } = defaultFor(field) as {
      hasDefault: boolean;
      value?: unknown;
      schema?: ZodDef;
    };
    const validatorSource =
      schema === undefined ? field : (schema as unknown as { _zod: unknown })._zod;
    const validate =
      schema === undefined
        ? validateFor(field)
        : (value: unknown) => (validatorSource as unknown as z.ZodType).safeParse(value).success;
    out[name] = hasDefault ? { default: undefined, validate } : { validate };
  }
  return out;
}

/**
 * The full node spec for a block type, minus the parts only ProseMirror can supply.
 *
 * `atom` is carried because the packet names four ATOMIC node types — `embedSimulation`,
 * `embedExternal`, `table` and `code` — and an atomic node with a React node view is the whole
 * trick for making a table or a code block a single focusable thing rather than hundreds of
 * focusable cells, which is what makes "no keyboard trap" tractable.
 */
export const ATOMIC_TYPES = ['embedSimulation', 'embedExternal', 'table', 'code'] as const;
export type AtomicType = (typeof ATOMIC_TYPES)[number];
export const isAtomic = (t: BlockType): boolean => (ATOMIC_TYPES as readonly string[]).includes(t);

export function nodeSpecFor(type: BlockType): {
  group: 'block';
  atom: boolean;
  attrs: Record<string, AttrSpec>;
} {
  return { group: 'block', atom: isAtomic(type), attrs: attrsFor(type) };
}
