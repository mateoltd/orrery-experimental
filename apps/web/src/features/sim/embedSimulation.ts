/**
 * `embedSimulation` rendering: resolving a block against the registry, and the parameter editor.
 * (P6-T7)
 *
 * ## A LESSON IS NEVER BROKEN BY A REGISTRY PROBLEM
 *
 * `plans/10` §5: an unknown `simId@simVersion` produces a STATIC FALLBACK plus a blocking authoring
 * warning. Not an error, not an empty box, and not a crash in a lesson a teacher has already shared.
 *
 * So resolution has four outcomes and only one of them is "render the frame". The distinction
 * matters: `UNKNOWN_SIM` is a broken lesson a human must fix, and `VERSION_MISMATCH` is a stored state
 * whose shape changed. Both render the fallback; they produce different warnings.
 *
 * ## THE PARAMETER EDITER IS DRIVEN BY THE REGISTRY, NOT BY THE BLOCK
 *
 * The block carries VALUES; the registry carries the ranges, the labels and the units. A slider
 * whose bounds come from the lesson means a teacher can set a parameter the sim cannot render, and a
 * sim author who widens a range has to find every lesson that assumed the old one.
 */

import { type Registry, type RegistryParam, type Resolution, resolve } from '@orrery/sim-registry';
import type { SeedPolicy, SimMode } from '@orrery/sim-sdk/protocol';

export interface EmbedSimulationBlock {
  readonly type: 'embedSimulation';
  readonly id: string;
  readonly simId: string;
  readonly simVersion: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly seedPolicy: 'FIXED' | 'PER_STUDENT' | 'PER_VIEW';
  readonly mode: 'explore' | 'practice' | 'graded';
}

export interface EmbedRenderPlan {
  /** Whether the frame is rendered at all. False for every fallback outcome. */
  readonly renderFrame: boolean;
  /** The bundle path, present ONLY when `renderFrame` is true. */
  readonly bundle: string | null;
  /** The seed policy the host should apply. */
  readonly seedPolicy: SeedPolicy | null;
  /** The host mode, mapped from the block's. */
  readonly mode: SimMode | null;
  /** The values, after clamping to the registry's declared ranges. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** The parameter editor's rows, driven by the REGISTRY. */
  readonly editor: readonly ParamRow[];
  /** A BLOCKING authoring warning. Present for every fallback outcome. */
  readonly warning: string | null;
  /**
   * Non-blocking but blocking-a-publish notices about the parameters, most importantly any value the
   * block carried that the simulation no longer declares.
   */
  readonly paramWarnings: readonly string[];
  readonly fallbackTextAlternative: string;
}

export interface ParamRow {
  readonly name: string;
  readonly label: string;
  readonly unit: string | null;
  readonly type: string;
  // Named exactly as the registry names them. A rename layer here cost two rounds of test churn and
  // served nobody: there is one vocabulary for a parameter's bounds.
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly value: string | number | boolean;
  /** True when the block's value was clamped or dropped. */
  readonly adjusted: boolean;
  /** A short sentence, or null when nothing needed saying. */
  readonly note: string | null;
}

/**
 * Plan the render.
 *
 * @param catalogueText The text alternative from the catalogue index. Required even on the failure
 *   paths, because the fallback IS the alternative: a student blocked by a firewall gets this sentence
 *   and nothing else.
 */
export function planEmbed(
  registry: Registry,
  block: EmbedSimulationBlock,
  catalogueText: string,
): EmbedRenderPlan {
  const resolution: Resolution = resolve(registry, block.simId, block.simVersion, {
    // A lesson block is a PINNED reference by construction, which is what stops a disabled version
    // from emptying a live classroom.
    pinned: true,
  });

  if (!resolution.ok) {
    return {
      renderFrame: false,
      bundle: null,
      seedPolicy: null,
      mode: null,
      params: {},
      editor: [],
      warning: authoringWarning(block, resolution),
      paramWarnings: [],
      fallbackTextAlternative: catalogueText,
    };
  }

  const entry = resolution.entry;
  const { values, editor, warnings } = reconcileParams(entry.parameters, block.params);
  return {
    renderFrame: true,
    bundle: entry.bundle.browser,
    seedPolicy: policyOf(block.seedPolicy, block.mode),
    mode: modeOf(block.mode),
    params: values,
    editor,
    warning: null,
    paramWarnings: warnings,
    fallbackTextAlternative: catalogueText,
  };
}

/** `FIXED` is the only policy a graded simulation may use, and the block schema enforces it. */
export function policyOf(
  policy: EmbedSimulationBlock['seedPolicy'],
  mode: EmbedSimulationBlock['mode'],
): SeedPolicy {
  if (mode === 'graded') {
    // Unreachable through the block schema, which already refuses it, and returning a fixed seed
    // rather than throwing is deliberate: this function renders a lesson, and a lesson must render.
    return { kind: 'FIXED', seed: '' };
  }
  if (policy === 'PER_VIEW') return { kind: 'PER_VIEW' };
  if (policy === 'FIXED') return { kind: 'FIXED', seed: '' };
  // USER_ID, not ASSIGNMENT_ID: a cohort sharing an assignment must not share a seed, or one
  // student's answer is another's. ATTEMPT_ID would re-roll on every attempt and make a retry a
  // different question.
  return { kind: 'PER_STUDENT', derivation: 'USER_ID' };
}

export function modeOf(mode: EmbedSimulationBlock['mode']): SimMode {
  return mode === 'graded' ? 'graded' : 'lesson';
}

/**
 * Reconcile the block's values against the registry's declarations.
 *
 * ## EVERY DISCREPANCY IS REPORTED, NOT SILENTLY CORRECTED
 *
 * A parameter the simulation no longer declares is DROPPED and a row says so. Clamping it instead
 * would send a value to a sim that never asked for it, and the block would keep carrying it forever
 * — so the lesson looks authored and behaves like something else.
 */
export function reconcileParams(
  declared: readonly RegistryParam[],
  supplied: Readonly<Record<string, string | number | boolean>>,
): {
  values: Record<string, string | number | boolean>;
  editor: ParamRow[];
  warnings: string[];
} {
  const values: Record<string, string | number | boolean> = {};
  const editor: ParamRow[] = [];
  const notes: string[] = [];

  for (const param of declared) {
    const raw = supplied[param.name];
    // `RegistryParam.default` is `unknown`, because it comes out of a manifest we have not
    // type-narrowed here. Coerced rather than cast: a manifest whose default is an object would
    // otherwise be stringified into the sim's state as "[object Object]".
    let value: string | number | boolean =
      typeof param.default === 'boolean' ||
      typeof param.default === 'number' ||
      typeof param.default === 'string'
        ? param.default
        : param.type === 'boolean'
          ? true
          : param.type === 'number' || param.type === 'integer'
            ? 0
            : '';
    let note: string | null = null;

    if (raw !== undefined) {
      if (param.type === 'number' || param.type === 'integer') {
        const parsed = param.type === 'integer' ? Math.round(Number(raw)) : Number(raw);
        if (!Number.isFinite(parsed)) {
          note = `the block's value ${JSON.stringify(raw)} is not a number, so ${String(value)} is used`;
        } else if (param.minimum !== null && parsed < param.minimum) {
          value = param.minimum;
          note = `raised to the minimum ${String(param.minimum)}, because the simulation no longer accepts ${String(parsed)}`;
        } else if (param.maximum !== null && parsed > param.maximum) {
          value = param.maximum;
          note = `lowered to the maximum ${String(param.maximum)}, because the simulation no longer accepts ${String(parsed)}`;
        } else {
          value = parsed;
        }
      } else if (param.type === 'boolean') {
        value = raw === true || raw === 'true' || raw === 'on';
      } else {
        value = String(raw);
      }
    }

    values[param.name] = value;
    editor.push({
      name: param.name,
      label: param.label,
      unit: param.unit,
      type: param.type,
      minimum: param.minimum,
      maximum: param.maximum,
      step: param.step,
      value,
      adjusted: note !== null,
      note,
    });
    if (note !== null) notes.push(`${param.name}: ${note}`);
  }

  for (const name of Object.keys(supplied)) {
    if (!declared.some((param) => param.name === name)) {
      // Dropped, and REPORTED. Passing it through would let a lesson write a value into a
      // simulation's state that the simulation never declared.
      notes.push(
        `The lesson sets "${name}", which this version of the simulation does not accept, so it was dropped. Known parameters: ${
          declared.map((param) => param.name).join(', ') || 'none'
        }.`,
      );
    }
  }

  // Clamp notes already live on their own row; these are what the rows cannot carry, because a
  // dropped value has no row at all. Without them a lesson quietly stops configuring something it
  // still claims to.
  return { values, editor, warnings: notes };
}

/** The BLOCKING authoring warning, and each reason gets its own because they need different fixes. */
function authoringWarning(
  block: EmbedSimulationBlock,
  resolution: Extract<Resolution, { ok: false }>,
): string {
  const where = `The simulation "${block.simId}@${block.simVersion}" in this lesson`;
  switch (resolution.reason) {
    case 'UNKNOWN_SIM':
      return `${where} is not in the registry. The block is rendered as text; pick a simulation that exists.`;
    case 'VERSION_MISMATCH':
      return `${where} is pinned to a version that is not built. ${resolution.message}`;
    case 'DISABLED':
      return `${where} has been disabled. It still renders for lessons already pointing at it, but do not add new ones.`;
    case 'NOT_BUILT':
      return `${where} has no build output. Run \`pnpm sim:build\`.`;
    default:
      return `${where} could not be resolved.`;
  }
}

/**
 * The PRINT projection.
 *
 * `plans/10` §5: "Print/PDF: poster plus text summary, so a printed worksheet still teaches
 * something." A printed worksheet carrying an empty box is a worksheet that teaches nothing, and a
 * student printing a lesson before a test is exactly who relies on it.
 */
export interface PrintProjection {
  readonly heading: string;
  /** Every declared parameter and its value, so the paper copy is reproducible. */
  readonly parameterLines: readonly string[];
  readonly textAlternative: string;
  /** True when the frame would have rendered — a printed note tells the reader to open the sim. */
  readonly pointsToLiveSim: boolean;
}

export function printProjection(plan: EmbedRenderPlan, heading: string): PrintProjection {
  return {
    heading,
    parameterLines: plan.editor.map(
      (row) =>
        `${row.label}: ${String(row.value)}${row.unit === null ? '' : ` ${row.unit}`}` +
        // A parameter the editor had to correct is printed with a MARK, because the printed value is
        // what the student will work from and it is not what the lesson said.
        (row.adjusted ? " (corrected — the lesson value is outside the simulation's range)" : ''),
    ),
    textAlternative: plan.fallbackTextAlternative,
    pointsToLiveSim: plan.renderFrame,
  };
}
