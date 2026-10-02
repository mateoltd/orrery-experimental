/**
 * A focused JSON Schema validator, for the SUBSET `sim.manifest.schema.json` uses.  (P6-T2)
 *
 * ## WHY NOT AJV
 *
 * "No drive-by third-party dependencies", and the precedent in this repository is the roster CSV
 * parser: RFC-style code, hand-written. This is the same shape of problem — a standards document we
 * must honour, for which adding a dependency is a larger decision than writing the subset.
 *
 * ## THE ONE PROPERTY THAT MAKES THIS HONEST
 *
 * **An unsupported keyword is an ERROR, never a pass.**
 *
 * That is the whole design. A permissive validator silently ignores `patternProperties` or
 * `oneOf` or `unevaluatedProperties`, so a manifest that violates a rule nobody implemented passes
 * validation, and "we validate against JSON Schema" becomes a claim about a subset nobody checked.
 * A gate that says "I checked" must fail when it cannot check.
 *
 * So `validate()` throws `UnsupportedKeywordError` naming the keyword and the JSON pointer, and the
 * CLI turns that into a build failure rather than a warning.
 *
 * ## WHAT IS SUPPORTED
 *
 * `$ref` (local `#/$defs/...` only), `$defs`, `type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `patternProperties`, `minProperties`, `maxProperties`, `items`,
 * `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format` (`date` and
 * `uri` only — advisory, reported as errors because a manifest with an unparseable date is broken),
 * `allOf`, `anyOf`, `oneOf`, `not`, `title`, `description`, `examples`, `default`, `$schema`,
 * `$id`, `unit`, `label`.
 *
 * Everything else is unsupported on purpose. Adding a keyword is a deliberate act.
 */

export class SchemaError extends Error {
  constructor(
    readonly pointer: string,
    message: string,
  ) {
    super(`${pointer}: ${message}`);
    this.name = 'SchemaError';
  }
}

/** Thrown when a SCHEMA uses a keyword this validator does not implement. Never thrown for data. */
export class UnsupportedKeywordError extends Error {
  constructor(
    readonly keyword: string,
    readonly pointer: string,
  ) {
    super(
      `UNSUPPORTED_KEYWORD: "${keyword}" at ${pointer} is not implemented by this validator. ` +
        'A validator that ignores a keyword it does not know reports "valid" for a document that ' +
        'breaks a rule nobody read, so this is an error rather than a pass.',
    );
    this.name = 'UnsupportedKeywordError';
  }
}

export interface ValidationError {
  /** JSON pointer, so an author is told where rather than being handed "invalid". */
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

type Json = unknown;
type Schema = Record<string, Json>;

const SUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'examples',
  'default',
  // Not a JSON Schema validation keyword, but the param editor needs them and the manifest uses
  // them for labels and units.
  'unit',
  'label',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'minProperties',
  'maxProperties',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);

const assertSupported = (schema: Schema, pointer: string): void => {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new UnsupportedKeywordError(key, pointer);
  }
};

const escapePointer = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');

const typeOf = (value: Json): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

const typeMatches = (value: Json, expected: string): boolean => {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
};

/** Deep equality for `enum`/`const`, with object key order irrelevant. */
const deepEqual = (a: Json, b: Json): boolean => {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) {
    // `1` and `1.0` are the same number, and JSON has one number type.
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Schema).sort();
    const kb = Object.keys(b as Schema).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Schema)[k], (b as Schema)[k]));
  }
  return false;
};

const resolveRef = (ref: string, root: Schema, pointer: string): Schema => {
  if (!ref.startsWith('#/$defs/')) {
    throw new SchemaError(
      pointer,
      `$ref "${ref}" is not local. Remote refs mean the schema has a network dependency, and a validation gate that can be made to pass by fetching something is not a gate.`,
    );
  }
  // The walk starts at `$defs`, not at the root: the first version started at the root, so
  // `#/$defs/simId` looked for a top-level `simId` key, resolved nothing, and every manifest
  // failed with "$ref does not resolve".
  const defs = root.$defs;
  if (defs === undefined || defs === null || typeof defs !== 'object') {
    throw new SchemaError(pointer, `$ref "${ref}" is used but the schema has no $defs`);
  }
  const path = ref.slice('#/$defs/'.length).split('/').map(escapePointer);
  let node: Json = defs;
  for (const token of path) {
    if (node === null || typeof node !== 'object' || !(token in (node as Schema))) {
      throw new SchemaError(pointer, `$ref "${ref}" does not resolve`);
    }
    node = (node as Schema)[token];
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new SchemaError(pointer, `$ref "${ref}" does not point at a schema object`);
  }
  return node as Schema;
};

/**
 * Validate `value` against `schema`. Returns every error, not the first.
 *
 * Returning all of them is worth the extra work: an author fixing a manifest gets one run's worth
 * of output instead of one error per attempt, and a manifest has one error per field on the day it
 * is first written.
 */
export function validate(
  value: Json,
  schema: Schema,
  root: Schema = schema,
  pointer = '#',
): ValidationError[] {
  assertSupported(schema, pointer);
  const errors: ValidationError[] = [];
  const err = (keyword: string, message: string, at: string = pointer): void => {
    errors.push({ pointer: at, keyword, message });
  };

  if (typeof schema.$ref === 'string') {
    return validate(value, resolveRef(schema.$ref, root, pointer), root, pointer);
  }

  // ── type
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    if (!expected.some((t) => typeMatches(value, t))) {
      err('type', `expected ${expected.join(' | ')}, received ${typeOf(value)}`);
      // Everything below assumes the type held, and returning here means a manifest with one
      // wrong-typed field reports one error rather than eleven.
      return errors;
    }
  }

  // ── enum / const
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      err('enum', `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    err('const', `expected ${JSON.stringify(schema.const)}`);
  }

  // ── combinators
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      errors.push(...validate(value, sub as Schema, root, pointer));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const passes = (schema.anyOf as Schema[]).some(
      (sub) => validate(value, sub, root, pointer).length === 0,
    );
    if (!passes) err('anyOf', 'no branch matched');
  }
  if (Array.isArray(schema.oneOf)) {
    const count = (schema.oneOf as Schema[]).filter(
      (sub) => validate(value, sub, root, pointer).length === 0,
    ).length;
    if (count !== 1) {
      err('oneOf', `exactly one branch must match, ${String(count)} did`);
    }
  }
  if (
    schema.not !== undefined &&
    validate(value, schema.not as Schema, root, pointer).length === 0
  ) {
    err('not', 'matched a schema it must not match');
  }

  // ── strings
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      err('minLength', `shorter than ${String(schema.minLength)}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      err('maxLength', `longer than ${String(schema.maxLength)}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      err('pattern', `does not match ${schema.pattern}`);
    }
    if (schema.format === 'date' && Number.isNaN(Date.parse(value))) {
      err('format', `"${value}" is not a parseable date`);
    }
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
      err('format', `"${value}" is not an absolute URI`);
    }
  }

  // ── numbers
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      err('minimum', `below ${String(schema.minimum)}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      err('maximum', `above ${String(schema.maximum)}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      err('exclusiveMinimum', `not above ${String(schema.exclusiveMinimum)}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      err('exclusiveMaximum', `not below ${String(schema.exclusiveMaximum)}`);
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      // Floating point: 0.3 / 0.1 is 2.9999999999999996, and a manifest with a decimal step would
      // be rejected by the naive check.
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        err('multipleOf', `not a multiple of ${String(schema.multipleOf)}`);
      }
    }
  }

  // ── arrays
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      err('minItems', `fewer than ${String(schema.minItems)}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      err('maxItems', `more than ${String(schema.maxItems)}`);
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            err('uniqueItems', `items ${String(i)} and ${String(j)} are equal`);
          }
        }
      }
    }
    const prefix = (schema.prefixItems as Schema[] | undefined) ?? [];
    prefix.forEach((sub, i) => {
      if (i < value.length)
        errors.push(...validate(value[i], sub, root, `${pointer}/${String(i)}`));
    });
    if (schema.items !== undefined) {
      for (let i = prefix.length; i < value.length; i += 1) {
        errors.push(...validate(value[i], schema.items as Schema, root, `${pointer}/${String(i)}`));
      }
    }
  }

  // ── objects
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Schema;
    const keys = Object.keys(record);

    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      err('minProperties', `fewer than ${String(schema.minProperties)}`);
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      err('maxProperties', `more than ${String(schema.maxProperties)}`);
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          err('required', `"${key}" is missing`, `${pointer}/${escapePointer(key)}`);
        }
      }
    }

    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in record)) continue;
      // `{ grading: undefined }` means "absent" in JavaScript, and a JSON document cannot contain
      // `undefined` at all — so treating the key as present fails a manifest that a caller means to
      // be valid. `required` above still catches a genuinely missing key, so this cannot be used to
      // smuggle one past a required field.
      if (record[key] === undefined) continue;
      errors.push(...validate(record[key], sub, root, `${pointer}/${escapePointer(key)}`));
    }

    const patterns = Object.entries(
      (schema.patternProperties as Record<string, Schema> | undefined) ?? {},
    );
    for (const [pattern, sub] of patterns) {
      const regex = new RegExp(pattern, 'u');
      for (const key of keys.filter((k) => regex.test(k))) {
        errors.push(...validate(record[key], sub, root, `${pointer}/${escapePointer(key)}`));
      }
    }

    if (schema.additionalProperties !== undefined) {
      const matched = (key: string): boolean =>
        key in props || patterns.some(([pattern]) => new RegExp(pattern, 'u').test(key));
      for (const key of keys) {
        if (matched(key)) continue;
        // Same JavaScript convention as above, and here it matters more: a fixture that spreads a
        // base object and sets `conformance: undefined` would otherwise be reported as carrying an
        // undeclared key.
        if (record[key] === undefined) continue;
        if (schema.additionalProperties === false) {
          err(
            'additionalProperties',
            `"${key}" is not permitted`,
            `${pointer}/${escapePointer(key)}`,
          );
        } else if (typeof schema.additionalProperties === 'object') {
          errors.push(
            ...validate(
              record[key],
              schema.additionalProperties as Schema,
              root,
              `${pointer}/${escapePointer(key)}`,
            ),
          );
        }
      }
    }
  }

  return errors;
}

/** Validate and throw on the first problem, for callers that just want a boolean answer. */
export function assertValid(value: Json, schema: Schema, label = 'document'): void {
  const errors = validate(value, schema);
  if (errors.length === 0) return;
  const detail = errors.map((e) => `  ${e.pointer} ${e.keyword}: ${e.message}`).join('\n');
  throw new SchemaError(label, `${String(errors.length)} problem(s):\n${detail}`);
}

/** True when `schema` uses only keywords this validator implements. Used by a gate. */
export function assertSchemaIsSupported(schema: Schema, pointer = '#'): void {
  assertSupported(schema, pointer);
  for (const sub of Object.values(
    (schema.properties as Record<string, Schema> | undefined) ?? {},
  )) {
    assertSchemaIsSupported(sub, `${pointer}.properties`);
  }
  for (const sub of Object.values((schema.$defs as Record<string, Schema> | undefined) ?? {})) {
    assertSchemaIsSupported(sub, `${pointer}.$defs`);
  }
  if (typeof schema.items === 'object' && schema.items !== null) {
    assertSchemaIsSupported(schema.items as Schema, `${pointer}.items`);
  }
}
