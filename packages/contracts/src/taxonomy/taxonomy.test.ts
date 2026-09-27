/**
 * The subject tree and tag algebra.  (P3-T1)
 *
 * ## The tests that matter
 *
 *  · `every ancestor/descendant pair is a cycle` — an EXHAUSTIVE check over a small tree, not two
 *    hand-picked cases. A cycle check tested on two examples is a cycle check that has not been
 *    tested.
 *  · `a walk that hits the depth limit reports no verdict` — the property that stops a "safe"
 *    answer about a structure the code did not read.
 */
import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  isSelfMerge,
  MAX_DEPTH,
  pathOf,
  slugify,
  subtreeOf,
  type TreeEdge,
  toSlug,
  wouldCreateCycle,
} from './index.js';

/**
 *   physics
 *   ├── mechanics
 *   │   ├── gravity
 *   │   └── waves
 *   └── optics
 *       └── lenses
 */
const TREE: TreeEdge = {
  physics: null,
  mechanics: 'physics',
  gravity: 'mechanics',
  waves: 'mechanics',
  optics: 'physics',
  lenses: 'optics',
};

const ids = Object.keys(TREE);

describe('cycle-safe moves', () => {
  it('rejects every ancestor/descendant pair, exhaustively', () => {
    // Not two hand-picked cases. For every (subject, candidate parent) pair, a verdict is
    // expected: true when the candidate is inside the subject's own subtree, false otherwise. A
    // cycle check tested on two examples is a cycle check that has not been tested.
    for (const subject of ids) {
      const descendants = new Set(subtreeOf(TREE, subject));
      for (const candidate of [...ids, null]) {
        const verdict = wouldCreateCycle(TREE, subject, candidate);
        const shouldCycle = candidate !== null && descendants.has(candidate);
        expect(verdict, `${subject} under ${String(candidate)}`).toEqual(
          shouldCycle ? { cycle: true, via: candidate as string } : { cycle: false },
        );
      }
    }
  });

  it('rejects moving a subject under ITSELF, and says so specifically', () => {
    expect(wouldCreateCycle(TREE, 'mechanics', 'mechanics')).toEqual({
      cycle: true,
      via: 'mechanics',
    });
  });

  it('rejects a move under a GRANDCHILD, which is the case people forget', () => {
    // mechanics > gravity > waves. Moving `mechanics` under `waves` is two levels up, and a
    // check that only looks at the immediate parent lets it through.
    expect(wouldCreateCycle(TREE, 'mechanics', 'waves')).toEqual({ cycle: true, via: 'waves' });
    expect(wouldCreateCycle(TREE, 'physics', 'gravity')).toEqual({ cycle: true, via: 'gravity' });
  });

  it('allows moving to the root, always, because a root has no ancestors', () => {
    // `parentId` is nullable and "move to the root" is a real operation, not a no-op.
    for (const subject of ids)
      expect(wouldCreateCycle(TREE, subject, null)).toEqual({ cycle: false });
  });

  it('allows an unrelated subtree', () => {
    expect(wouldCreateCycle(TREE, 'optics', 'mechanics')).toEqual({ cycle: false });
    expect(wouldCreateCycle(TREE, 'gravity', 'optics')).toEqual({ cycle: false });
  });

  it('reports NO VERDICT when the walk hits the depth limit', () => {
    // A chain deeper than MAX_DEPTH. "No cycle" here would be a claim about a structure the
    // function did not read, and a claim that is indistinguishable from a real answer.
    const deep: TreeEdge = {};
    for (let i = 0; i < MAX_DEPTH + 5; i += 1) deep[`s${i}`] = i === 0 ? null : `s${i - 1}`;
    // A candidate FURTHER down than the walk can reach. The first version used
    // `s${MAX_DEPTH - 1}`, which is exactly on the boundary and is therefore judged — a
    // depth-limit test with the candidate inside the limit tests nothing.
    const tooDeep = `s${MAX_DEPTH + 4}`;
    // `at` is where the WALK STOPPED, not the candidate. The author already knows which parent
    // they chose; telling them so is not information. Telling them the walk reached `s4` and gave
    // up is: it says the chain is at least MAX_DEPTH long, which is the actual finding.
    expect(wouldCreateCycle(deep, 's0', tooDeep)).toEqual({ depthExceeded: true, at: 's4' });
    expect(wouldCreateCycle(deep, 's0', tooDeep).at).not.toBe(tooDeep);
    // The boundary itself is still judged, which is the other half: MAX_DEPTH is a limit on
    // judgement, not a limit on safety.
    expect(wouldCreateCycle(deep, 's0', `s${MAX_DEPTH - 1}`)).toEqual({
      cycle: true,
      via: `s${MAX_DEPTH - 1}`,
    });
    // And a chain just inside the limit IS judged.
    const shallow: TreeEdge = {};
    for (let i = 0; i < 10; i += 1) shallow[`s${i}`] = i === 0 ? null : `s${i - 1}`;
    expect(wouldCreateCycle(shallow, 's0', 's9')).toEqual({ cycle: true, via: 's9' });
  });

  it('does not judge a parent that does not exist', () => {
    // A dangling parent is a foreign key error at write time, and calling it a cycle would
    // conflate two different failures.
    expect(wouldCreateCycle(TREE, 'optics', 'no-such-subject')).toEqual({ cycle: false });
  });
});

describe('walking a tree that is already broken', () => {
  it('ancestorsOf stops instead of spinning', () => {
    // The invariant is supposed to prevent this, so it must be tested as an INPUT.
    const cyclic: TreeEdge = { a: 'b', b: 'a' };
    expect(ancestorsOf(cyclic, 'a')).toEqual(['b', 'a']);
  });

  it('subtreeOf terminates on a cycle', () => {
    const cyclic: TreeEdge = { a: 'b', b: 'a', c: 'a' };
    expect(subtreeOf(cyclic, 'a').sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('paths and subtrees', () => {
  it('builds a root-first breadcrumb', () => {
    const names = { physics: 'Physics', mechanics: 'Mechanics', gravity: 'Gravity' };
    expect(pathOf(TREE, names, 'gravity')).toEqual(['Physics', 'Mechanics', 'Gravity']);
  });

  it('returns the subject and everything beneath it', () => {
    expect(subtreeOf(TREE, 'mechanics').sort()).toEqual(['gravity', 'mechanics', 'waves']);
    expect(subtreeOf(TREE, 'physics').sort()).toEqual([
      'gravity',
      'lenses',
      'mechanics',
      'optics',
      'physics',
      'waves',
    ]);
  });
});

describe('slugs', () => {
  it('lowercases, dashes, and strips accents', () => {
    expect(slugify('Quantum Mechanics')).toBe('quantum-mechanics');
    expect(slugify('Café')).toBe('cafe');
    // An accent left behind becomes a percent-encoding in a URL that a teacher has already shared.
    expect(slugify('Café')).not.toContain('%');
  });

  it('handles the punctuation a subject name actually contains', () => {
    expect(slugify('Physics (Grade 11)')).toBe('physics-grade-11');
    expect(slugify('  Waves  &  Optics ')).toBe('waves-optics');
    expect(slugify('A/B testing')).toBe('a-b-testing');
  });

  it('refuses a name with nothing a URL can carry, and says why', () => {
    const verdict = toSlug('☠');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // A refusal with no reason is a support ticket.
    expect(verdict.reason).toContain('no characters');
  });

  it('refuses an empty name', () => {
    expect(toSlug('   ').ok).toBe(false);
  });

  it('does not leave a trailing dash after truncating', () => {
    // Truncating at 80 characters mid-word leaves `-` at the end, which is a slug that ends in a
    // dash in every canonical URL.
    const long = `${'a'.repeat(79)} tail`;
    expect(slugify(long)).not.toMatch(/-$/);
  });
});

describe('tag merge', () => {
  it('refuses to merge a tag into itself', () => {
    // The obvious way to lose a tag: merge it into itself and delete it.
    expect(isSelfMerge('t1', 't1')).toBe(true);
    expect(isSelfMerge('t1', 't2')).toBe(false);
  });
});
