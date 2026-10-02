/**
 * `embedSimulation`: resolution, the parameter editor, and the print projection.  (P6-T7)
 *
 * ## THE TESTS THAT MATTER MOST
 *
 *  - `an unknown sim renders TEXT plus a BLOCKING warning, and never an empty box` — a lesson a teacher
 *    has already shared must not break because of a registry problem.
 *  - `a parameter the simulation no longer declares is DROPPED and said so` — clamping it instead would
 *    send a value to a sim that never asked for it, and the block would carry it forever.
 *  - `a parameter the lesson set outside the sim's new range is CLAMPED and MARKED, not silently
 *    accepted` — a lesson that looks authored and behaves like something else is worse than one that
 *    says so.
 *  - `the PRINT projection marks a corrected value, because the paper copy is what the student works
 *    from`.
 */
import {
  buildRegistry,
  type Registry,
  type RegistryEntry,
  type RegistryParam,
} from '@orrery/sim-registry';
import { describe, expect, it } from 'vitest';
import {
  type EmbedSimulationBlock,
  modeOf,
  planEmbed,
  policyOf,
  printProjection,
  reconcileParams,
} from './embedSimulation.js';

const TEXT = 'At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds.';

const params = (): RegistryParam[] => [
  {
    name: 'speed',
    type: 'number',
    label: 'Launch speed',
    unit: 'm/s',
    minimum: 5,
    maximum: 60,
    step: null,
    default: 25,
  },
  {
    name: 'angle',
    type: 'number',
    label: 'Launch angle',
    unit: 'degrees',
    minimum: 5,
    maximum: 85,
    step: null,
    default: 45,
  },
  {
    name: 'showTrail',
    type: 'boolean',
    label: 'Show trail',
    unit: null,
    minimum: null,
    maximum: null,
    step: null,
    default: true,
  },
];

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: 'maths.projectile-motion',
  version: '1.0.0',
  lifecycle: 'ACTIVE',
  replacedById: null,
  licence: 'CC-BY-4.0',
  bundle: {
    page: './sim.cccc55556666.html',
    browser: './browser.aaaa11112222.js',
    grader: './grader.bbbb33334444.js',
    style: null,
  },
  bytes: { browser: 11_773, grader: 6_018, total: 17_791 },
  defaultHeight: 420,
  minHeight: 240,
  parameters: params(),
  ...over,
});

const registryOf = (entries: readonly RegistryEntry[]): Registry => buildRegistry(entries, 'test');

const block = (over: Partial<EmbedSimulationBlock> = {}): EmbedSimulationBlock => ({
  type: 'embedSimulation',
  id: 'block-1',
  simId: 'maths.projectile-motion',
  simVersion: '1.0.0',
  params: { speed: 25, angle: 45 },
  seedPolicy: 'FIXED',
  mode: 'explore',
  ...over,
});

describe('resolution', () => {
  it('renders the frame when the pin resolves', () => {
    const plan = planEmbed(registryOf([entry()]), block(), TEXT);
    expect(plan.renderFrame).toBe(true);
    expect(plan.bundle).toBe('./browser.aaaa11112222.js');
    expect(plan.warning).toBeNull();
    expect(plan.mode).toBe('lesson');
  });

  it('an UNKNOWN sim renders TEXT plus a BLOCKING warning, and never an empty box', () => {
    const plan = planEmbed(registryOf([entry()]), block({ simId: 'maths.nope' }), TEXT);
    expect(plan.renderFrame).toBe(false);
    expect(plan.bundle).toBeNull();
    // The alternative is STILL rendered, because for a student blocked by a firewall this sentence is
    // the entire lesson.
    expect(plan.fallbackTextAlternative).toBe(TEXT);
    expect(plan.warning).toMatch(/not in the registry/u);
    expect(plan.editor).toEqual([]);
  });

  it("a VERSION MISMATCH warns in the author's terms and names the pin", () => {
    const plan = planEmbed(registryOf([entry()]), block({ simVersion: '9.9.9' }), TEXT);
    expect(plan.renderFrame).toBe(false);
    expect(plan.warning).toMatch(/pinned to a version that is not built/u);
    expect(plan.warning).toMatch(/1\.0\.0/u);
  });

  it('a DISABLED sim STILL renders for a lesson already pointing at it', () => {
    // A lesson block is a pinned reference by construction. The alternative is every student in a live
    // classroom losing the simulation out of their lesson on the day it was switched off.
    const plan = planEmbed(registryOf([entry({ lifecycle: 'DISABLED' })]), block(), TEXT);
    expect(plan.renderFrame).toBe(true);
  });

  it('a DEPRECATED sim renders, because a live classroom is never broken by a registry decision', () => {
    const plan = planEmbed(
      registryOf([entry({ lifecycle: 'DEPRECATED', replacedById: 'maths.projectile-motion-2' })]),
      block(),
      TEXT,
    );
    expect(plan.renderFrame).toBe(true);
  });
});

describe('seed policy and mode', () => {
  it('FIXED is the policy, and the seed is filled in by the HOST, not the lesson', () => {
    // The lesson stores no seed: a stored seed in a shared lesson would give every student in the
    // class the same numbers, which is the anti-collusion claim failing by accident.
    expect(policyOf('FIXED', 'explore')).toEqual({ kind: 'FIXED', seed: '' });
  });

  it('each block policy maps to its OWN host policy, rather than one catch-all', () => {
    expect(policyOf('PER_STUDENT', 'explore')).toEqual({
      kind: 'PER_STUDENT',
      derivation: 'USER_ID',
    });
    // PER_VIEW is NOT the same request as PER_STUDENT: one re-rolls per mount, the other per person.
    // Collapsing them makes a student's refresh show a different ball every time they blink.
    expect(policyOf('PER_VIEW', 'practice')).toEqual({ kind: 'PER_VIEW' });
    expect(policyOf('FIXED', 'practice')).toEqual({ kind: 'FIXED', seed: '' });
  });

  it('derives PER_STUDENT from USER_ID, so a cohort does not share one answer', () => {
    // ASSIGNMENT_ID would give every student in a class the same numbers, and ATTEMPT_ID would make a
    // retry a different question.
    expect(policyOf('PER_STUDENT', 'explore')).not.toEqual({
      kind: 'PER_STUDENT',
      derivation: 'ASSIGNMENT_ID',
    });
  });

  it('a GRADED mount is `graded`, and a graded mount refuses a per-student policy', () => {
    expect(modeOf('graded')).toBe('graded');
    expect(modeOf('practice')).toBe('lesson');
    // Unreachable through the block schema, which already refuses it — and returning a fixed seed
    // rather than throwing is deliberate, because this function renders a lesson.
    expect(policyOf('PER_STUDENT', 'graded')).toEqual({ kind: 'FIXED', seed: '' });
  });
});

describe('the parameter editor', () => {
  it('is driven by the REGISTRY, so a sim author changing a range reaches every lesson', () => {
    const plan = planEmbed(registryOf([entry()]), block({ params: {} }), TEXT);
    expect(plan.editor.map((row) => row.name)).toEqual(['speed', 'angle', 'showTrail']);
    expect(plan.editor[0]).toEqual({
      name: 'speed',
      label: 'Launch speed',
      unit: 'm/s',
      type: 'number',
      minimum: 5,
      maximum: 60,
      step: null,
      value: 25,
      adjusted: false,
      note: null,
    });
  });

  it("a parameter OUTSIDE the sim's range is CLAMPED and MARKED, not silently accepted", () => {
    const plan = planEmbed(registryOf([entry()]), block({ params: { speed: 500 } }), TEXT);
    const speed = plan.editor.find((row) => row.name === 'speed');
    expect(speed?.value).toBe(60);
    expect(speed?.adjusted).toBe(true);
    expect(speed?.note).toMatch(/no longer accepts 500/u);
    // A lesson that looks authored and behaves like something else is worse than one that says so.
    expect(plan.params.speed).toBe(60);
  });

  it('a parameter the sim NO LONGER DECLARES is DROPPED, not passed through', () => {
    // Passing it through would let a lesson write a value into a sim's state that the sim never
    // declared, and the block would carry it forever.
    const { values, warnings } = reconcileParams(params(), { speed: 30, retiredParam: 'legacy' });
    expect(Object.keys(values).sort()).toEqual(['angle', 'showTrail', 'speed']);
    expect(values).not.toHaveProperty('retiredParam');
    // With no row to hang it on, a dropped value is INVISIBLE unless it is also reported, so a lesson
    // quietly stops configuring something it still claims to.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/retiredParam/u);
    expect(warnings[0]).toMatch(/does not accept/u);
  });

  it('a NON-NUMERIC value falls back to the declared default and says so', () => {
    const { editor } = reconcileParams(params(), { speed: 'fast' });
    const speed = editor.find((row) => row.name === 'speed');
    expect(speed?.value).toBe(25);
    expect(speed?.note).toMatch(/not a number/u);
  });

  it('an INTEGER parameter rounds, because 45.7 degrees is not what the editor offered', () => {
    const { values } = reconcileParams(
      [
        {
          name: 'n',
          type: 'integer',
          label: 'N',
          unit: null,
          minimum: null,
          maximum: null,
          step: 1,
          default: 1,
        },
      ],
      { n: 45.7 },
    );
    expect(values.n).toBe(46);
  });

  it('a boolean accepts the strings a form actually sends', () => {
    const { values } = reconcileParams(params(), { showTrail: 'on' });
    expect(values.showTrail).toBe(true);
    expect(reconcileParams(params(), { showTrail: 'off' }).values.showTrail).toBe(false);
  });

  it('a block with NO params gets every declared default, so a sim is never mounted half-configured', () => {
    const { values, editor } = reconcileParams(params(), {});
    expect(values).toEqual({ speed: 25, angle: 45, showTrail: true });
    expect(editor.every((row) => row.adjusted === false)).toBe(true);
  });
});

describe('the print projection', () => {
  it('prints the parameters, so a paper worksheet is reproducible', () => {
    const plan = planEmbed(registryOf([entry()]), block({ params: { speed: 30 } }), TEXT);
    const projection = printProjection(plan, 'Projectile motion');
    expect(projection.heading).toBe('Projectile motion');
    expect(projection.parameterLines.join(' ')).toMatch(/Launch speed: 30 m\/s/u);
    expect(projection.textAlternative).toBe(TEXT);
    expect(projection.pointsToLiveSim).toBe(true);
  });

  it('MARKS a corrected value, because the paper copy is what the student works from', () => {
    const plan = planEmbed(registryOf([entry()]), block({ params: { speed: 500 } }), TEXT);
    const projection = printProjection(plan, 'Projectile motion');
    // Without the mark, the student works from 60 m/s while the lesson says 500 and neither is right.
    expect(projection.parameterLines.join(' ')).toMatch(/corrected/u);
  });

  it('still prints the alternative when the frame will not render, and says the sim is not live', () => {
    const plan = planEmbed(registryOf([entry()]), block({ simId: 'maths.nope' }), TEXT);
    const projection = printProjection(plan, 'Projectile motion');
    expect(projection.textAlternative).toBe(TEXT);
    expect(projection.pointsToLiveSim).toBe(false);
    // A printed worksheet carrying an empty box is a worksheet that teaches nothing.
    expect(projection.parameterLines).toEqual([]);
  });
});
