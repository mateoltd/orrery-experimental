/**
 * Attribute specs, and the null trap they close.  (P2-T3b)
 *
 * ## The test this file is for
 *
 * `NO ATTR IS EVER UNGUARDED` — every attribute of every one of the 16 types has a `validate` or
 * a `default`, and never neither. That is the invariant which makes the P2-T3a measurement
 * impossible to reproduce: a ProseMirror attr with neither accepts `undefined` and yields `null`
 * silently, so the fix had to be in the declaration rather than in a check after the fact.
 *
 * It runs over ALL 16 types, because a single unguarded attr anywhere is the whole bug and
 * checking the one type you happened to look at is how it survives.
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_SCHEMAS, BLOCK_TYPES, type BlockType } from '../blocks/index.js';
import { ATOMIC_TYPES, attrsFor, fieldsFor, isAtomic, nodeSpecFor } from './attrSpecs.js';

describe('the schema map', () => {
  it('covers every type in the union, and nothing else', () => {
    // The map is a CLAIM — Zod v4 does not expose a union's members for lookup — so totality is
    // asserted here. A type added to the union and not the map gets no editor attributes at all,
    // which looks like a block the editor silently cannot edit.
    expect(Object.keys(BLOCK_SCHEMAS).sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it('agrees with the union on which types exist', () => {
    for (const t of BLOCK_TYPES) expect(BLOCK_SCHEMAS[t], t).toBeDefined();
  });
});

describe('NO ATTR IS EVER UNGUARDED', () => {
  const unguarded: string[] = [];

  it('across all 16 types', () => {
    for (const type of BLOCK_TYPES) {
      for (const [name, spec] of Object.entries(attrsFor(type))) {
        // The measured bug: `validate` absent AND `default` absent => `undefined` in, `null`
        // out, no error. `params` has a default; nothing else may rely on one.
        if (spec.validate === undefined && spec.default === undefined) {
          unguarded.push(`${type}.${name}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
    // And a non-trivial number of attrs were actually checked, so this is not vacuous.
    const total = BLOCK_TYPES.reduce((n, t) => n + Object.keys(attrsFor(t)).length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it('rejects undefined and null for every REQUIRED field, which is the trap', () => {
    // The exact failure the probe produced.
    //
    // "Required" is derived from the schema rather than assumed, because the first version of
    // this test asserted that EVERY field rejects `undefined` and failed on `heading.anchor` --
    // which is OPTIONAL, and an optional field accepting `undefined` is its contract, not a bug.
    // Asserting the blunt version would have meant either weakening the check to nothing or
    // "fixing" a correct optional field into a required one.
    const failures: string[] = [];
    let requiredCount = 0;
    for (const type of BLOCK_TYPES) {
      for (const [name, field] of Object.entries(fieldsFor(type))) {
        const optional = field.safeParse(undefined).success;
        const spec = attrsFor(type)[name];
        if (optional) {
          expect(
            spec?.validate?.(undefined),
            `${type}.${name} is optional but rejects undefined`,
          ).toBe(true);
          continue;
        }
        requiredCount += 1;
        if (spec?.validate?.(undefined) !== false)
          failures.push(`${type}.${name} accepts undefined`);
        if (spec?.validate?.(null) !== false) failures.push(`${type}.${name} accepts null`);
      }
    }
    expect(failures).toEqual([]);
    expect(requiredCount, 'the check must actually be looking at required fields').toBeGreaterThan(
      40,
    );
  });
});

describe('the validators are the schema, not a copy of it', () => {
  it('enforces a uuid on `id`', () => {
    const attrs = attrsFor('divider');
    expect(attrs.id?.validate?.('00000000-0000-4000-8000-00000000aa01')).toBe(true);
    expect(attrs.id?.validate?.('not-a-uuid')).toBe(false);
  });

  it('enforces the regex on `simId`', () => {
    const attrs = attrsFor('embedSimulation');
    expect(attrs.simId?.validate?.('tidal-locking')).toBe(true);
    expect(attrs.simId?.validate?.('NOT A SLUG')).toBe(false);
  });

  it('enforces the enum on `mode`', () => {
    const attrs = attrsFor('embedSimulation');
    expect(attrs.mode?.validate?.('graded')).toBe(true);
    expect(attrs.mode?.validate?.('GRADED')).toBe(false);
  });

  it('requires a RECORD for `params`, not undefined — the unwrapped default', () => {
    // `z.record(...).default({})` is a `default` wrapping a `record`. Validating against the
    // WRAPPER accepts `undefined`, which is precisely the value an attr must not accept, so
    // this is the case where the unwrapping actually matters.
    const attrs = attrsFor('embedSimulation');
    // Key PRESENCE, not a defined value. ProseMirror decides "has a default" with `'default' in
    // attrs`, so `default: undefined` is a real default declaration and reading `.default` to
    // check for it would pass whether or not the key exists.
    expect('default' in (attrs.params ?? {}), 'params declares a default').toBe(true);
    expect(attrs.params?.validate?.({ bodies: 'earth,moon', dt: 0.01 })).toBe(true);
    expect(attrs.params?.validate?.('nope')).toBe(false);
  });

  it('agrees with safeParse on a spread of real values', () => {
    // The strongest form of "the validator IS the schema": for every field of every type, the
    // attr's `validate` and the field's own `safeParse` must return the same answer. If they
    // ever diverge, the validator has become a second rule.
    const divergences: string[] = [];
    for (const type of BLOCK_TYPES) {
      for (const [name, field] of Object.entries(fieldsFor(type))) {
        const validate = attrsFor(type)[name]?.validate;
        if (validate === undefined) continue;
        const samples = [undefined, null, '', 'x', 0, 1, {}, [], true, 'FIXED', 'solid', 'graded'];
        for (const s of samples) {
          if (validate(s) !== field.safeParse(s).success) {
            divergences.push(`${type}.${name} on ${JSON.stringify(s) ?? 'undefined'}`);
          }
        }
      }
    }
    expect(divergences).toEqual([]);
  });
});

describe('fields', () => {
  it('excludes `type`, which is the node discriminant rather than an attribute', () => {
    // Declaring it as an attr too would give the same value two homes, and the two could differ.
    for (const type of BLOCK_TYPES) {
      expect(Object.keys(fieldsFor(type)), type).not.toContain('type');
    }
  });

  it('throws for a type with no object shape, rather than returning nothing', () => {
    // A silent `{}` produces a block type with no attributes, which looks like a valid empty
    // block rather than a missing schema — the worst kind of failure to debug.
    expect(() => fieldsFor('nope' as BlockType)).toThrow();
  });
});

describe('atomic nodes', () => {
  it('marks exactly the four the packet names', () => {
    expect(ATOMIC_TYPES).toEqual(['embedSimulation', 'embedExternal', 'table', 'code']);
    for (const t of ATOMIC_TYPES) expect(isAtomic(t), t).toBe(true);
  });

  it('leaves the other twelve non-atomic', () => {
    const rest = BLOCK_TYPES.filter((t) => !isAtomic(t));
    expect(rest).toHaveLength(12);
  });

  it('is why "no keyboard trap" is tractable at all', () => {
    // A table is 6 columns x 40 rows = 240 cells. As 240 focusable things that is not an editor,
    // it is a maze, and the "no keyboard trap" requirement becomes impossible. As ONE atomic node
    // with a React node view it is a single focusable thing, which is the whole reason the
    // packet asks for these four to be atomic.
    const table = nodeSpecFor('table');
    expect(table.atom).toBe(true);
    // And it still carries its fields, so the node view has everything it needs to render.
    expect(Object.keys(table.attrs).sort()).toEqual([
      'alignments',
      'caption',
      'header',
      'id',
      'rows',
    ]);
  });
});
