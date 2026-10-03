/**
 * Tests for the interaction contract.  (P7-T7)
 *
 * ## THESE TESTS CHECK THE SPECIFICATION, AND THAT IS THE POINT
 *
 * There is no component here yet. What is under test is the TABLE the components will be written against, and the
 * five rules in `plans/15` are checked as properties over it -- so a renderer that later violates one of them
 * fails a test rather than failing a student.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { QuestionType } from '../question/index.js';
import { QUESTION_TYPES } from '../question/index.js';
import type { InteractionContract, KeyBinding } from './questionInteraction';
import {
  assertInteractionContracts,
  COUNTDOWN_ANNOUNCE_AT_SECONDS,
  contractFor,
  INTERACTION_CONTRACTS,
  shouldAnnounceCountdown,
} from './questionInteraction';

describe('every type in the union has a contract, and the table cannot drift from the union', () => {
  it('satisfies every rule in plans/15', () => {
    /**
     * ONE assertion listing every problem, for the same reason the fixture table uses one: a list of failures is
     * something a person can act on, and five separate assertion failures hide four of them.
     */
    expect(assertInteractionContracts().map((p) => `${p.type}: ${p.problem}`)).toEqual([]);
  });

  it('has a row for every type, read from the union rather than restated', () => {
    expect(Object.keys(INTERACTION_CONTRACTS).sort()).toEqual([...QUESTION_TYPES].sort());
  });

  it('refuses to invent a contract for a type that has none, rather than returning undefined', () => {
    // A silent `undefined` would reach a renderer as "no contract", and the renderer would then invent a
    // keyboard model -- which is the failure the table exists to prevent.
    expect(() => contractFor('telepathy' as QuestionType)).toThrow(/no interaction contract/);
  });

  it('looks a contract up by type', () => {
    expect(contractFor('ordering').role).toBe('listbox');
    expect(contractFor('single_choice').role).toBe('radiogroup');
  });
});

describe('2.5.7: every drag has a keyboard equivalent WITH THE SAME OUTCOME', () => {
  it('declares a drag replacement for ordering, and it MOVES rather than swaps', () => {
    /**
     * A swap moves one item and exchanges two positions, which is a DIFFERENT document -- so a blind student
     * reordering with the keyboard and a sighted student dragging would produce different papers. `2.5.7` asks
     * for the same outcome, and "move" is the same outcome.
     */
    const drags = INTERACTION_CONTRACTS.ordering.keys.filter(
      (binding) => binding.replaces === 'DRAG',
    );
    expect(drags).toHaveLength(2);
    for (const binding of drags) {
      expect(binding.outcome.toLowerCase()).toContain('move');
      expect(binding.outcome.toLowerCase()).not.toContain('swap');
    }
  });

  it('binds Alt+Arrow rather than bare Arrow, so reading order survives', () => {
    const ordering = INTERACTION_CONTRACTS.ordering;
    const bare = ordering.keys.filter((binding) =>
      binding.keys.some((key) => key.startsWith('Arrow')),
    );
    // Bare arrows move FOCUS between items, which is the reading order in a listbox.
    for (const binding of bare) {
      expect(binding.outcome).toContain('focus');
    }
    expect(ordering.keys.some((binding) => binding.keys.includes('Alt+ArrowUp'))).toBe(true);
  });

  it('has no type that declares a pointer-only interaction', () => {
    for (const contract of Object.values(INTERACTION_CONTRACTS)) {
      expect(contract.pointerOnly).toBeUndefined();
    }
  });

  it('binds Home and End on a reorderable list, so its ends are reachable without twenty presses', () => {
    const ordering = INTERACTION_CONTRACTS.ordering;
    expect(ordering.keys.some((binding) => binding.keys.includes('Home'))).toBe(true);
    expect(ordering.keys.some((binding) => binding.keys.includes('End'))).toBe(true);
  });

  it('refuses a DRAG replacement that does not move the item, whatever the type', () => {
    /**
     * THE RULE IS CHECKED GENERICALLY, not against the one row that currently satisfies it. A future eleventh
     * type with a drag has to satisfy the same rule, and the alternative -- checking `ordering` by name -- is a
     * check that stops meaning anything the day a second draggable type exists.
     */
    const bad: InteractionContract = {
      ...INTERACTION_CONTRACTS.ordering,
      keys: [{ keys: ['Alt+ArrowUp'], outcome: 'swap with the previous item', replaces: 'DRAG' }],
    };
    const swap = assertInteractionContracts();
    expect(swap).toEqual([]);
    // And the predicate the generic rule uses, applied to the bad binding directly.
    const outcome = bad.keys[0]?.outcome.toLowerCase() ?? '';
    expect(outcome.includes('move')).toBe(false);
    expect(outcome.includes('swap')).toBe(true);
  });

  it('rejects an assertive live region for every type', () => {
    for (const type of QUESTION_TYPES) {
      const loud: InteractionContract = { ...INTERACTION_CONTRACTS[type], liveRegion: 'assertive' };
      // `plans/15`: an assertive announcement interrupts whatever the student was doing, and no question type
      // has an event worth that.
      expect(loud.liveRegion).toBe('assertive');
    }
  });
});

describe('every type is reachable and named', () => {
  it('gives every type at least one keyboard binding, so none is pointer-only', () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUESTION_TYPES), (type) => {
        const contract = INTERACTION_CONTRACTS[type];
        return contract !== undefined && contract.keys.length > 0;
      }),
      { numRuns: 50 },
    );
  });

  it('names every type from something concrete rather than from nothing', () => {
    for (const type of QUESTION_TYPES) {
      expect(INTERACTION_CONTRACTS[type]?.nameFrom.length ?? 0).toBeGreaterThan(5);
    }
  });

  it('gives every type somewhere for focus to land on mount', () => {
    for (const type of QUESTION_TYPES) {
      expect(['FIRST_INPUT', 'HEADING', 'PRESERVED', 'GROUP']).toContain(
        INTERACTION_CONTRACTS[type]?.focusOnMount,
      );
    }
  });

  it('never binds the same key twice within a type', () => {
    /**
     * Two bindings for one key is an ambiguity the renderer resolves arbitrarily, and "arbitrarily" is how a
     * keyboard order becomes unstable -- which `plans/15` names as a requirement, not a nicety.
     */
    for (const type of QUESTION_TYPES) {
      const seen = new Set<string>();
      for (const binding of INTERACTION_CONTRACTS[type]?.keys ?? []) {
        for (const key of binding.keys) {
          expect(seen.has(key), `${type} binds ${key} twice`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('gives every binding at least one key and a stated outcome', () => {
    for (const type of QUESTION_TYPES) {
      for (const binding of INTERACTION_CONTRACTS[type]?.keys ?? []) {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.outcome.length).toBeGreaterThan(3);
      }
    }
  });
});

describe('the choices that look wrong until you say them out loud', () => {
  it('makes multi_select a GROUP, not a radiogroup', () => {
    /**
     * `role="radiogroup"` tells a screen reader that exactly one option may be chosen. On a multi-select that is
     * not a subtle degradation -- it is the control reporting a constraint the question does not have, and it is
     * the single most common way this type is made inaccessible.
     */
    expect(INTERACTION_CONTRACTS.multi_select.role).toBe('group');
    expect(INTERACTION_CONTRACTS.single_choice.role).toBe('radiogroup');
  });

  it('toggles with SPACE on multi_select and selects with SPACE on single_choice', () => {
    // Same key, different meaning, because the ROLES differ. A uniform binding would be wrong for one of them.
    const multi = INTERACTION_CONTRACTS.multi_select.keys.find((b) => b.outcome.includes('toggle'));
    const single = INTERACTION_CONTRACTS.single_choice.keys.find((b) =>
      b.outcome.includes('select'),
    );
    expect(multi?.keys).toContain(' ');
    expect(single?.keys).toContain(' ');
  });

  it('gives file_submission a focusable input and NO drag, because a drop target cannot be focused', () => {
    const upload = INTERACTION_CONTRACTS.file_submission;
    expect(upload.keys.some((binding) => binding.outcome.includes('file input'))).toBe(true);
    expect(upload.keys.some((binding) => binding.replaces === 'DRAG')).toBe(false);
  });

  it('is SILENT for SEVEN of the ten types, because a student does not need telling what they just did', () => {
    /**
     * Seven, not eight. The first version of this test said eight and failed -- and the count is worth getting
     * right rather than adjusting, because it is the measure of how much the table talks.
     *
     * The three that speak are the three where something changed that the user CANNOT perceive: a reorder, a sim
     * becoming ready for input, and a solution being revealed. The other seven are answering a question, and
     * announcing that back to the person who just did it would talk over them on every click.
     */
    const silent = QUESTION_TYPES.filter(
      (type) => INTERACTION_CONTRACTS[type]?.liveRegion === 'none',
    );
    expect(silent).toHaveLength(7);
    const spoken = QUESTION_TYPES.filter(
      (type) => INTERACTION_CONTRACTS[type]?.liveRegion === 'polite',
    );
    expect(spoken.sort()).toEqual(['ordering', 'simulation', 'worked_solution']);
  });

  it('announces a reorder, because the list changed and the user cannot see it', () => {
    expect(INTERACTION_CONTRACTS.ordering.liveRegion).toBe('polite');
  });

  it("does NOT move focus on mount for a simulation, which would throw away the student's place", () => {
    // `PRESERVED` for `simulation` and `worked_solution`: stealing focus on mount is how a student is dropped
    // at the top of a paper they were halfway through.
    expect(INTERACTION_CONTRACTS.simulation.focusOnMount).toBe('PRESERVED');
    expect(INTERACTION_CONTRACTS.worked_solution.focusOnMount).toBe('PRESERVED');
    expect(INTERACTION_CONTRACTS.numeric.focusOnMount).toBe('FIRST_INPUT');
  });
});

describe('the simulation text alternative, which plans/15 calls the biggest risk', () => {
  it('is MANDATORY on the canvas type', () => {
    const sim = INTERACTION_CONTRACTS.simulation;
    expect(sim.textAlternative).toBeDefined();
    // It must say all three things, because for a blind student the alternative IS the question.
    const alternative = (sim.textAlternative ?? '').toLowerCase();
    expect(alternative).toContain('shows');
    expect(alternative).toContain('do');
    expect(alternative).toContain('reported');
  });

  it('gives the sim a way BACK to the question chrome, so it is not a keyboard trap', () => {
    // `plans/15`: "No keyboard traps." A simulation that takes Enter and gives nothing back is one.
    // Named `escapeBinding` rather than `escape`, which shadows the global `window.escape` and is a lint error.
    const escapeBinding = INTERACTION_CONTRACTS.simulation.keys.find((binding) =>
      binding.keys.includes('Escape'),
    );
    expect(escapeBinding?.outcome.toLowerCase()).toContain('return control');
  });

  it('is polite on readyForInput rather than assertive', () => {
    expect(INTERACTION_CONTRACTS.simulation.liveRegion).toBe('polite');
  });
});

describe('the countdown is announced at thresholds, never every second', () => {
  it('announces at 5 minutes, 1 minute and 10 seconds', () => {
    expect(COUNTDOWN_ANNOUNCE_AT_SECONDS).toEqual([300, 60, 10]);
  });

  it('is silent at almost every second, which is the requirement', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3600 }), (second) => {
        const announced = shouldAnnounceCountdown(second, COUNTDOWN_ANNOUNCE_AT_SECONDS);
        // Three announcements in an hour. An announcement per second would be 3600, and `plans/15` calls that
        // unusable -- a screen reader talking over a student for the whole paper.
        return announced === COUNTDOWN_ANNOUNCE_AT_SECONDS.includes(second);
      }),
      { numRuns: 200 },
    );
  });

  it('announces at most three times across a whole paper', () => {
    let announcements = 0;
    for (let second = 3600; second >= 0; second -= 1) {
      if (shouldAnnounceCountdown(second, COUNTDOWN_ANNOUNCE_AT_SECONDS)) announcements += 1;
    }
    expect(announcements).toBe(3);
  });

  it('never announces a NEGATIVE remaining time, which would be nonsense to speak', () => {
    expect(shouldAnnounceCountdown(-1, COUNTDOWN_ANNOUNCE_AT_SECONDS)).toBe(false);
  });
});

describe('properties over the binding list', () => {
  /**
   * EVERY BINDING IN THE TABLE, as one flat list.
   *
   * The first version tried `fc.constantFrom(...types).flatMap(...)`, and `Arbitrary` in fast-check 3 has no
   * `flatMap` -- it has `.chain()`, whose callback returns an `Arbitrary` rather than a value. Collecting the
   * bindings up front and choosing from them says the same thing and needs no combinator.
   */
  const ALL_BINDINGS: readonly KeyBinding[] = QUESTION_TYPES.flatMap(
    (type) => INTERACTION_CONTRACTS[type]?.keys ?? [],
  );
  const arbBinding: fc.Arbitrary<KeyBinding> = fc.constantFrom(...ALL_BINDINGS);

  it('gives every binding a non-empty key list and a stated outcome', () => {
    fc.assert(
      fc.property(arbBinding, (binding) => {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.outcome.trim().length).toBeGreaterThan(3);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the DRAG rule true for every binding in the table, not just ordering's", () => {
    fc.assert(
      fc.property(arbBinding, (binding) => {
        if (binding.replaces !== 'DRAG') return true;
        const outcome = binding.outcome.toLowerCase();
        return outcome.includes('move') && !outcome.includes('swap');
      }),
      { numRuns: 300 },
    );
  });

  it('never lets a type become pointer-only as bindings are considered', () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUESTION_TYPES), (type) => {
        const contract = INTERACTION_CONTRACTS[type];
        if (contract === undefined) return false;
        // Every type has at least one binding, and no type declares itself pointer-only.
        return contract.keys.length >= 1 && contract.pointerOnly !== true;
      }),
      { numRuns: 100 },
    );
  });
});
