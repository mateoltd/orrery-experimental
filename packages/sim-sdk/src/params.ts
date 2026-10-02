/**
 * Parameters, as the sim author writes them and as the host edits them.  (P6-T3)
 *
 * ## WHY THE AUTHOR DECLARES TYPES AND THE HOST STILL VALIDATES
 *
 * `num({ min: 5, max: 60, default: 25, unit: 'm/s' })` is a declaration, not enforcement. The value
 * that reaches `simulate()` has been through a student's browser, a manifest, a pinned version and
 * a URL, so it is attacker-controlled in the same way any request body is. `clampParams` is the
 * boundary, and it is the only place a param is trusted.
 *
 * ## A DEFAULT OUTSIDE ITS OWN RANGE IS A THROWN ERROR, NOT A CLAMP
 *
 * Clamping silently would make the sim start in a state the author never wrote, and the only
 * symptom is a student reporting that the numbers look wrong. Throwing during validation means the
 * manifest is refused at CI, which is where the author is still reading.
 */

import type { SimErrorCode } from './protocol.js';

export type ParamType = 'number' | 'integer' | 'boolean' | 'string' | 'enum';

/**
 * `label` is OPTIONAL, and `plans/10` §4's own example is why.
 *
 * ```ts
 * speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' })
 * ```
 *
 * No label. The display label lives in `sim.manifest.json`, which is what the host's parameter
 * editor renders and what a translator sees — so an author writing physics is not asked for a string,
 * and a label cannot drift between the sim and the editor. `sim:validate` still refuses a manifest
 * whose param has no label, because there the label is the thing being checked.
 */
export interface ParamSpecBase {
  readonly label?: string;
  readonly description?: string;
  readonly unit?: string;
}

export interface NumberParamSpec extends ParamSpecBase {
  readonly type: 'number' | 'integer';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly default: number;
}

export interface BooleanParamSpec extends ParamSpecBase {
  readonly type: 'boolean';
  readonly default: boolean;
}

export interface StringParamSpec extends ParamSpecBase {
  readonly type: 'string';
  readonly default: string;
  readonly maxLength?: number;
}

export interface EnumParamSpec extends ParamSpecBase {
  readonly type: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}

export type ParamSpec = NumberParamSpec | BooleanParamSpec | StringParamSpec | EnumParamSpec;

/** `num({ min: 5, max: 60, default: 25, unit: 'm/s' })` — the plan's own example, verbatim. */
export const num = (spec: Omit<NumberParamSpec, 'type'>): NumberParamSpec => ({
  ...spec,
  type: spec.step !== undefined && Number.isInteger(spec.step) ? 'integer' : 'number',
});

export const int = (spec: Omit<NumberParamSpec, 'type'>): NumberParamSpec => ({
  ...spec,
  type: 'integer',
});

export const bool = (spec: Omit<BooleanParamSpec, 'type'>): BooleanParamSpec => ({
  ...spec,
  type: 'boolean',
});

export const str = (spec: Omit<StringParamSpec, 'type'>): StringParamSpec => ({
  ...spec,
  type: 'string',
});

export const choice = (
  spec: Omit<EnumParamSpec, 'type' | 'values'> & { readonly values: readonly string[] },
): EnumParamSpec => ({ ...spec, type: 'enum' });

/** `{ speed: 25, angle: 45 }` — `string | number | boolean` because that is what a JSON value is. */
export type ParamValues = Readonly<Record<string, string | number | boolean>>;

export interface ParamProblem {
  readonly name: string;
  readonly code: SimErrorCode | 'PARAM_DEFAULT_INVALID' | 'PARAM_RANGE_INVALID';
  readonly message: string;
}

/**
 * Is a declaration coherent?  (`plans/10` §3.1, as a pure function)
 *
 * Separate from `clampParams` on purpose. This asks "is the DECLARATION sensible" and runs at CI on
 * the manifest; that asks "is this VALUE usable" and runs at the trust boundary.
 */
export function validateParamSpecs(specs: Record<string, ParamSpec>): ParamProblem[] {
  const out: ParamProblem[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    // Only a label that is PRESENT and blank is a problem. An absent one is the normal case: the
    // label is the manifest's to supply.
    if (spec.label !== undefined && spec.label.trim() === '') {
      out.push({
        name,
        code: 'PARAM_INVALID',
        message: 'a parameter with a blank label cannot be rendered',
      });
    }
    if (spec.type === 'number' || spec.type === 'integer') {
      if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
        out.push({
          name,
          code: 'PARAM_RANGE_INVALID',
          message: `minimum ${String(spec.min)} exceeds maximum ${String(spec.max)}`,
        });
      }
      if (spec.default < (spec.min ?? Number.NEGATIVE_INFINITY)) {
        out.push({
          name,
          code: 'PARAM_DEFAULT_INVALID',
          message: `default ${String(spec.default)} is below the minimum ${String(spec.min)}`,
        });
      }
      if (spec.default > (spec.max ?? Number.POSITIVE_INFINITY)) {
        out.push({
          name,
          code: 'PARAM_DEFAULT_INVALID',
          message: `default ${String(spec.default)} is above the maximum ${String(spec.max)}`,
        });
      }
      if (spec.type === 'integer' && !Number.isInteger(spec.default)) {
        out.push({
          name,
          code: 'PARAM_DEFAULT_INVALID',
          message: `an integer parameter cannot default to ${String(spec.default)}`,
        });
      }
      if (spec.step !== undefined && spec.step <= 0) {
        out.push({
          name,
          code: 'PARAM_RANGE_INVALID',
          message: `step ${String(spec.step)} must be positive, or the editor cannot move`,
        });
      }
    }
    if (spec.type === 'enum') {
      if (spec.values.length === 0) {
        out.push({
          name,
          code: 'PARAM_INVALID',
          message: 'an enum parameter with no values cannot be rendered',
        });
      }
      if (!spec.values.includes(spec.default)) {
        out.push({
          name,
          code: 'PARAM_DEFAULT_INVALID',
          message: `default "${spec.default}" is not one of ${spec.values.join(', ')}`,
        });
      }
    }
  }
  return out;
}

/**
 * The trust boundary. Coerce a caller-supplied value into something `simulate()` may rely on.
 *
 * ## EVERY BRANCH HERE IS A CASE THAT HAPPENED OR WOULD HAPPEN
 *
 * The value arrives from `sim:setParams`, which arrives from an author preview, a URL, or a
 * manifest — so: a number arrives as a string from an `<input>`, a value out of range arrives from
 * a hand-edited query string, and an unknown key arrives from a newer host talking to an older sim.
 * Each is handled by falling back to the declared default rather than throwing, because a sim that
 * refuses to render is worse for a student than one that starts at the author's default — and the
 * host logs the coercion.
 */
export function clampParams(
  specs: Record<string, ParamSpec>,
  supplied: Partial<ParamValues> | undefined,
): { values: ParamValues; coerced: string[] } {
  const values: Record<string, string | number | boolean> = {};
  const coerced: string[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    const raw = supplied?.[name];
    const asText = raw === undefined ? 'absent' : JSON.stringify(raw);

    switch (spec.type) {
      case 'number':
      case 'integer': {
        const wanted = spec.type === 'integer' ? Math.round(Number(raw)) : Number(raw);
        if (raw === undefined) {
          // ABSENT IS NOT A COERCION. Logging it put one line per unused parameter in `coerced` for
          // every ordinary call, which is how a real out-of-range clamp became the third line of
          // output nobody read.
          values[name] = spec.default;
          continue;
        }
        if (raw === null || raw === '' || !Number.isFinite(wanted)) {
          coerced.push(`${name}: ${asText} -> default ${String(spec.default)}`);
          values[name] = spec.default;
          continue;
        }
        let value = wanted;
        if (spec.min !== undefined && value < spec.min) {
          coerced.push(`${name}: ${asText} -> clamped to min ${String(spec.min)}`);
          value = spec.min;
        }
        if (spec.max !== undefined && value > spec.max) {
          coerced.push(`${name}: ${asText} -> clamped to max ${String(spec.max)}`);
          value = spec.max;
        }
        values[name] = value;
        continue;
      }
      case 'boolean': {
        if (raw === undefined) {
          values[name] = spec.default;
          continue;
        }
        if (typeof raw === 'boolean') {
          values[name] = raw;
          continue;
        }
        // An `<input type="checkbox">` sends the string "on", and a query string sends "true".
        const text = typeof raw === 'string' ? raw.toLowerCase() : '';
        if (text === 'true' || text === 'on' || text === '1') values[name] = true;
        else if (text === 'false' || text === 'off' || text === '0' || text === '')
          values[name] = false;
        else {
          coerced.push(`${name}: ${asText} -> default ${String(spec.default)}`);
          values[name] = spec.default;
        }
        continue;
      }
      case 'string': {
        if (raw === undefined) {
          values[name] = spec.default;
          continue;
        }
        if (typeof raw === 'string') {
          const capped =
            spec.maxLength !== undefined && raw.length > spec.maxLength
              ? raw.slice(0, spec.maxLength)
              : raw;
          if (capped !== raw)
            coerced.push(`${name}: truncated to ${String(spec.maxLength)} characters`);
          values[name] = capped;
          continue;
        }
        coerced.push(`${name}: ${asText} -> default`);
        values[name] = spec.default;
        continue;
      }
      case 'enum': {
        if (raw === undefined) {
          values[name] = spec.default;
          continue;
        }
        if (typeof raw === 'string' && spec.values.includes(raw)) {
          values[name] = raw;
          continue;
        }
        coerced.push(`${name}: ${asText} -> default "${spec.default}"`);
        values[name] = spec.default;
        continue;
      }
    }
  }

  // An UNKNOWN key is dropped, not passed through. A newer host sending a parameter an older sim
  // does not know about must not be able to inject a property into `simulate`'s params object.
  for (const name of Object.keys(supplied ?? {})) {
    if (!(name in specs)) coerced.push(`${name}: unknown parameter dropped`);
  }

  return { values: values as ParamValues, coerced };
}

/** Does this declaration of params fit the budget the manifest declared?  (P6-T7) */
export function paramSpecsAreSerializable(specs: Record<string, ParamSpec>): boolean {
  try {
    JSON.parse(JSON.stringify(specs));
    return true;
  } catch {
    return false;
  }
}
