/**
 * `defineSim`, and the split that makes dual-target grading possible.  (P6-T3)
 *
 * ## THE TYPE SPLIT IS THE WHOLE OF `INV-SIM-2`
 *
 * `defineSim` returns TWO things, and the type system makes it impossible to put a DOM call in the
 * wrong one:
 *
 *  - `grader` — takes `(state, params, answer)` and returns a `Grade`. Its parameter types contain
 *    no DOM type, so a `document` reference inside it is a compile error rather than something the
 *    bundle metafile catches after it is built.
 *  - `browser` — the render layer, `void` of DOM types on purpose so it cannot accidentally be
 *    imported into a grader bundle.
 *
 * The first version had one `SimDefinition` with an optional `render`, which meant "pure" was a
 * promise in a comment and a `render` was a legal argument to the function the grader host calls.
 *
 * ## `simulate` IS DECLARED PURE BY HAVING NO WAY TO OBSERVE
 *
 * It receives `(params, state, t)` and returns a value. There is no handle, no clock, no rng. A sim
 * that needs randomness gets it from `seeded(seed)` in its browser layer, where the seed is visible,
 * rather than from a source that would make the same state produce two different papers.
 */

import { createRng, type Rng } from '@orrery/rng';
import type { Grade } from './grading.js';
import { clampParams, type ParamSpec, type ParamValues, validateParamSpecs } from './params.js';

/**
 * The licences a simulation may ship under. Mirrors `licenceSchema` in `@orrery/contracts`.
 *
 * DECLARED HERE RATHER THAN IMPORTED because a grader bundle's transitive closure is asserted to
 * contain no third-party code (`RN-07`), and the SDK does not take a runtime dependency on contracts to
 * express six string literals. **The two lists must be edited together** — `sim:validate` checks the
 * manifest against contracts, so a licence added here but not there typechecks and then fails the
 * manifest, and the reverse fails the build.
 */
export const LICENCES = [
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'MIT',
  'OFL-1.1',
  'PUBLIC-DOMAIN',
] as const;
export type Licence = (typeof LICENCES)[number];

/** Mirrors `provenanceSchema`: `ORIGINAL`, `PORTED`, or `INSPIRED_BY:<ref>`. */
export type Provenance = 'ORIGINAL' | 'PORTED' | `INSPIRED_BY:${string}`;

export interface SimControls {
  /**
   * A play/pause/step/scrub stepper. Implemented by the SDK so every one is keyboard-reachable.
   *
   * Optional, and an absent flag reads as `false`. It used to be required, which meant every one of the
   * twenty-two simulations with no stepper had to write `stepper: false` to satisfy the type — so a
   * declaration where the flag is the norm looked like an exception, and the two simulations that DO
   * have a stepper were the only ones whose `controls` read as a deliberate claim. (The manifest's
   * `capabilities.stepper` is a different field and is separately required by the schema.)
   */
  readonly stepper?: boolean;
  /** Step size in the sim's own time unit, for the stepper's step button. */
  readonly stepSize?: number;
  /** Named scenarios, which the host offers as a menu. */
  readonly scenarios: readonly string[];
  /** Continuous time from 0 to 1 by default. */
  readonly maxTime?: number;
  /**
   * Whether the host offers a parameter editor. Optional, and an ABSENT flag reads as `false`.
   *
   * The capability is already declared in `SimCapabilities` (`protocol.ts`), and this is the sim's own
   * statement about what its render half bothers to build. Keeping it optional means a sim with no
   * parameter editor says nothing rather than writing `params: false` in two places, and the two
   * declarations are allowed to disagree visibly rather than being silently merged.
   */
  readonly params?: boolean;
  /** Whether the host offers a state inspector. Optional, absent reads as `false`. */
  readonly state?: boolean;
}

/**
 * The four fields `schemas/sim.manifest.schema.json` requires of `$defs/accessibility`, plus the two
 * the manifest carries elsewhere.
 *
 * **THE THREE NEW ONES ARE REQUIRED, NOT OPTIONAL, BECAUSE THE SCHEMA REQUIRES THEM.**
 * `keyboard`, `screenReaderSummary` and `reducedMotion` are all in that schema's `required` array,
 * while `textAlternative` has been required here since the first version. Two simulations declared only
 * the first of the three in code while their own manifests declared all four, so the manifest and the
 * module made different accessibility claims about the same file.
 */
export interface SimAccessibility {
  /** Whether the sim is operable from the keyboard alone. Required by the manifest schema. */
  readonly keyboard: boolean;
  /** What a screen reader announces first. Required by the manifest schema, and at least 20 characters. */
  readonly screenReaderSummary: string;
  /** Whether the sim honours `prefers-reduced-motion`. Required by the manifest schema. */
  readonly reducedMotion: boolean;
  /** One sentence, in the student's terms. The host reads it aloud and shows it in print. */
  readonly textAlternative: string;
  /** A shorter description for the catalogue. */
  readonly summary: string;
  /** What a screen reader should announce when the sim is ready. */
  readonly readyAnnouncement?: string;
}

export interface SimMeta {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly subjects: readonly string[];
  /**
   * THE SPELLING IS `licence`, AND IT IS NOT A MATTER OF TASTE.
   *
   * `schemas/sim.manifest.schema.json:13` lists `licence` in its top-level `required`, all 25 manifests
   * in this repository write `licence`, and `licenceSchema` (`@orrery/contracts`) is the validator.
   * **Every simulation's `meta` block spelled it `license`**, so the code and the manifest it ships
   * beside disagreed about the legal terms of every simulation in the set — and the type had no `licence`
   * field for the manifest's to be written into at all. P12-T3 makes licence and provenance mandatory,
   * so this is where they live now.
   */
  readonly licence: Licence;
  /** `ORIGINAL`, `PORTED`, or `INSPIRED_BY:<ref>`. Mandatory for the same reason `licence` is. */
  readonly provenance: Provenance;
  /** The frame protocol version this sim speaks. Mirrors the manifest's top-level `protocol`. */
  readonly protocol: number;
}

/** The PURE half. Every parameter here is JSON-serialisable. */
export interface GraderHalf<P = ParamValues, S = unknown> {
  readonly meta: SimMeta;
  readonly params: Readonly<Record<string, ParamSpec>>;
  readonly controls: SimControls;
  readonly accessibility: SimAccessibility;
  /**
   * State -> model. Pure, so the same `(params, state, t)` gives the same answer in a browser, in
   * Node and in a conformance run three years from now.
   *
   * ## OPTIONAL, BECAUSE TWENTY-THREE OF THE TWENTY-FOUR SIMULATIONS HAVE NO SUCH FUNCTION
   *
   * A simulation whose grader is a question — "work out the midpoint of this segment", "name the
   * forces in this scenario" — has no state and no clock, so it has nothing to model. Its arithmetic
   * lives in `model.ts` and its browser half calls that directly; `browser.ts` is a loader that
   * dynamically imports `sim.ts`, so there is no path from `defineSim` to a render loop at all.
   *
   * Nothing outside this package calls it: `scripts/sim-conformance.mjs` reads `half.grader.controls`
   * (line 145) and calls `gradeStoredState` (line 163), never `simulate`. So it was a requirement with
   * no consumer, satisfied by twenty-three authors writing `simulate: (_p, _s) => undefined` or
   * re-exporting a model that nothing invokes — twenty-three stubs whose only purpose was to make a
   * type stop complaining, which is the kind of declaration that makes a type meaningless.
   *
   * The purity guarantee is NOT weakened by making it optional: `INV-SIM-2` is enforced by
   * `tsconfig.grader.json`, which checks the grader half's transitive closure with `types: []` and no
   * `dom` at all. That is a stronger statement than "every author wrote the word `simulate`".
   */
  readonly simulate?: (params: P, state: S, t: number) => unknown;
  /** State + answer -> grade. The server's authority; a sim's own `gradePreview` is decorative. */
  readonly grade: (state: S, params: P, answer: unknown) => Grade;
  /** Validate a serialised state. Return `null` when it is fine. */
  readonly validateState?: (state: unknown) => string | null;
}

/** The BROWSER half. Nothing here may be imported into a grader bundle. */
export interface RenderContext<P = ParamValues, S = unknown> {
  readonly params: P;
  readonly state: S;
  readonly t: number;
  readonly rng: Rng;
  /** Emit an answer. The host records it; it is not an answer until the server has scored it. */
  reportAnswer(
    answer: unknown,
    meta?: { readonly confidence?: number; readonly explanation?: string },
  ): void;
  /** Announce something to a screen reader. Routed through a live region, never spoken directly. */
  announce(message: string): void;
  /** Push an unsolicited state checkpoint, debounced by the HOST. */
  checkpoint(state: S): void;
  /** Set the sim's intrinsic size, so the frame can resize without a `ResizeObserver` fight. */
  requestHeight(height: number): void;
}

/**
 * The browser half. `P` types `RenderContext.params`, which is what it is there for.
 *
 * ## WHY `P` IS BACK, AND WHY THE PREVIOUS REASON WAS WRONG
 *
 * This interface used to take `P` and not use it, and the comment here claimed that was honest because
 * "the render layer receives params through `RenderContext`". That was true of the *mechanism* and
 * wrong about the *consequence*: `RenderContext.params` was typed `ParamValues`, so every browser half
 * had to write `ctx.params as ModelParams` — a cast asserting a shape the SDK had just promised not to
 * know. Fifteen such casts were in `sims/`. The fix was never to drop `P` from `BrowserHalf` but to put
 * it where the parameters actually are, one level down.
 */
export interface BrowserHalf<P = ParamValues, S = unknown> {
  /**
   * The render layer, and OPTIONAL because most modules here do not have one.
   *
   * `defineSim` is the single entry point for BOTH halves, and twenty-three of the twenty-four
   * simulations call it from their grader with no browser half at all: their `browser.ts` is a loader
   * that dynamically imports `sim.ts`, so the render loop lives in a module the SDK never sees.
   * Requiring `render` here meant those twenty-three either stubbed it or -- because the error was
   * being masked by a second one on `grade` -- were never told, and the requirement was satisfied by
   * nothing. `mount` and `unmount` were already propagated conditionally; this is the same treatment.
   */
  readonly render?: (ctx: RenderContext<P, S>) => void;
  /** Called once with the `sim:init` params and seed. */
  readonly mount?: (ctx: RenderContext<P, S>) => void;
  readonly unmount?: () => void;
}

export interface SimDefinition<P = ParamValues, S = unknown>
  extends GraderHalf<P, S>,
    BrowserHalf<P, S> {}

export interface SimModule<P = ParamValues, S = unknown> {
  /** The pure half, safe to import in Node with no DOM present. */
  readonly grader: GraderHalf<P, S>;
  /** The browser half. Importing THIS in Node is a mistake, and the type system says so. */
  readonly browser: BrowserHalf<P, S>;
}

/**
 * Declare a simulation.
 *
 * ## THE CHECKS RUN HERE RATHER THAN IN A TEST
 *
 * `defineSim` is called at module load, so a malformed declaration fails on the FIRST import — in the
 * conformance run, in the validator, in a student's browser — rather than when somebody notices the
 * slider does nothing. The alternative is a `validate()` call that an author can forget, and a
 * forgotten validation is the same as no validation.
 *
 * ## `params` DEFAULTS ARE NOT TRUSTED EITHER
 *
 * A declared default outside its own range is a bug in the declaration, so it throws here rather than
 * being clamped later: a sim that starts in a state the author never wrote is a support ticket.
 *
 * ## AND `P` IS CONSTRAINED TO `object`, NOT TO `ParamValues`, WHICH IS THE WHOLE ARGUMENT
 *
 * `P` used to be `<P extends ParamValues>`, and `ParamValues` is `Record<string, string | number |
 * boolean>` — an INDEX SIGNATURE. **TypeScript does not give an `interface` an implicit index
 * signature**, so `defineSim<OrreryParams, …>` was unsatisfiable for every sim whose parameters are
 * declared as an `interface` (all of them; a `type` alias would have worked, which is why it read as
 * an authoring quirk rather than a defect). The symptom was indirect and uniform: `P` fell back to its
 * constraint, so every sim's `grade(_state: X, params: OwnParams, answer)` became "not assignable to
 * `(state: X, params: Record<string, string | number | boolean>, answer) => Grade`", and every test
 * passing `Record<string, unknown>` to `gradeStoredState` failed for the same reason behind it.
 *
 * The constraint that was doing the damage was protecting nothing: `ParamValues` describes what comes
 * off a wire after `clampParams`, which is a boundary concern already enforced in `clampParams` itself.
 * An author's parameter type is their own domain type, and requiring it to be index-signature-shaped
 * bought a lie in exchange for nothing.
 */
export function defineSim<P extends object = ParamValues, S = unknown>(
  definition: SimDefinition<P, S>,
): SimModule<P, S> {
  /**
   * THE GRADER'S ARITY IS PART OF THE CONTRACT, AND IT IS CHECKED.
   *
   * The grader half is `grade(state, params, answer)` — three positional arguments. Three gold
   * simulations were written `grade(answer, context)`, so the SDK handed them the PARAMETERS as the
   * answer and the answer as the parameters: `parseAnswer` failed, **every answer scored 0**, and the
   * conformance run printed a confident number derived from the wrong things. It passed, because a
   * two-argument function is not a type error at runtime and nothing else was looking.
   *
   * TypeScript checks the signature for a TypeScript author and cannot check it for a JavaScript one, and
   * a grader bundle is a plain object at runtime. So it is checked here, at the point of definition, where
   * the failure is a load-time error naming the simulation — rather than a silent zero that reaches a
   * student.
   */
  if (definition.grade.length !== 3) {
    throw new Error(
      `GRADER_ARITY in ${definition.meta.id}: grade takes (state, params, answer) — three arguments — ` +
        `and this one takes ${String(definition.grade.length)}. A grader with the wrong arity is handed ` +
        'the parameters as its answer and the answer as its parameters, so every mark it awards is zero ' +
        'and nothing anywhere reports an error.',
    );
  }
  const problems = validateParamSpecs(definition.params);
  if (problems.length > 0) {
    throw new Error(
      `INVALID_PARAM_DECLARATION in ${definition.meta.id}: ${problems
        .map((p) => `${p.name} — ${p.message}`)
        .join('; ')}`,
    );
  }
  if (definition.accessibility.textAlternative.trim().length < 20) {
    throw new Error(
      `WEAK_TEXT_ALTERNATIVE in ${definition.meta.id}: the text alternative is shorter than 20 ` +
        'characters. A student with the sim blocked by a school firewall, or printed to a worksheet, ' +
        'gets nothing else.',
    );
  }
  if (definition.accessibility.summary.trim().length < 20) {
    throw new Error(
      `WEAK_SUMMARY in ${definition.meta.id}: the summary is shorter than 20 characters`,
    );
  }
  if (!Number.isInteger(definition.meta.id.length) || definition.meta.id.trim() === '') {
    throw new Error(`MISSING_SIM_ID: every sim needs an id`);
  }
  const maxTime = definition.controls.maxTime;
  if (maxTime !== undefined && (!Number.isFinite(maxTime) || maxTime <= 0)) {
    throw new Error(
      `BAD_MAX_TIME in ${definition.meta.id}: maxTime must be a positive finite number`,
    );
  }
  // A stepper needs a RANGE, which is `maxTime` -- and nothing about `scenarios`. The first version
  // tested `scenarios.length === 0 && stepper` while the message talked about `maxTime`, so every
  // stepper sim with no scenarios was refused and every stepper sim WITH scenarios and no maxTime was
  // accepted. A condition and its message disagreeing is the signature of a check nobody ran.
  if (definition.controls.stepper && maxTime === undefined) {
    throw new Error(
      `STEP_WITHOUT_TIME in ${definition.meta.id}: the stepper is enabled but maxTime is not set, ` +
        'so the scrubber has no range to scrub. Scenarios are unrelated and may be empty.',
    );
  }
  if (definition.controls.stepSize !== undefined && definition.controls.stepSize <= 0) {
    throw new Error(`BAD_STEP_SIZE in ${definition.meta.id}: stepSize must be positive`);
  }

  const grader: GraderHalf<P, S> = {
    meta: definition.meta,
    params: definition.params,
    controls: definition.controls,
    accessibility: definition.accessibility,
    grade: definition.grade,
    // CONDITIONALLY, because a key present with the value `undefined` is not the same object as a key
    // absent: `hostBridge` and the conformance runner both test `('render' in browser)`-style presence
    // to decide whether a module has a render layer, and a stub key would make a grader-only module
    // look like a simulator that forgot to draw.
    ...(definition.simulate === undefined ? {} : { simulate: definition.simulate }),
    ...(definition.validateState === undefined ? {} : { validateState: definition.validateState }),
  };
  const browser: BrowserHalf<P, S> = {
    ...(definition.render === undefined ? {} : { render: definition.render }),
    ...(definition.mount === undefined ? {} : { mount: definition.mount }),
    ...(definition.unmount === undefined ? {} : { unmount: definition.unmount }),
  };
  return { grader, browser };
}

/**
 * The one entry point a Node grader host is allowed to call.
 *
 * Exists so `B14`'s grader host has a single documented surface, and so the param clamping that the
 * browser does at the trust boundary also happens when the worker re-grades stored state. A grader
 * called directly with attacker-shaped params would otherwise be the one path that skips the
 * boundary.
 */
export function gradeStoredState<P extends object, S>(
  module: GraderHalf<P, S>,
  input: {
    readonly state: unknown;
    readonly params: Partial<P> | undefined;
    readonly answer: unknown;
  },
): Grade {
  const { values } = clampParams(module.params, input.params as Partial<ParamValues> | undefined);
  const declared = input.state;
  if (module.validateState !== undefined) {
    const problem = module.validateState(declared);
    if (problem !== null) {
      throw new Error(`STATE_INVALID: ${problem}`);
    }
  }
  return module.grade(declared as S, values as P, input.answer);
}

export { createRng, type Rng };
