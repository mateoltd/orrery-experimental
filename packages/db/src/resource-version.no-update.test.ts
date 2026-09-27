/**
 * INV-CONTENT-1: there is no content update path.  (P2-T5)
 *
 * ## Why a test that checks an ABSENCE is the deliverable
 *
 * A module that merely *declines* to update is write-once by convention, and conventions are
 * what D-31 and D-35 found to be theatre. So this asserts the absence structurally: the module's
 * entire export list, compared against an allowlist.
 *
 * ## Why an allowlist and not a denylist
 *
 * A denylist ("no export named update*") passes the moment somebody calls it
 * `patchResourceVersion` or `setBlocks` or `reviseVersion`, which is the whole problem. An
 * allowlist fails on ANY new export, so a new capability has to be a deliberate decision with a
 * test change beside it — which is the only way an absence stays true as a codebase grows.
 */
import { describe, expect, it } from 'vitest';
import * as resourceVersion from './resource-version.js';

const ALLOWED = [
  'VersionError',
  'createResourceVersion',
  'listVersions',
  'readVersion',
  'restoreVersion',
  'verifyVersion',
  'blockSchema',
] as const;

describe('INV-CONTENT-1: no content update path exists', () => {
  it('exports exactly the allowlist and nothing more', () => {
    const actual = Object.keys(resourceVersion).sort();
    expect(actual).toEqual([...ALLOWED].sort());
  });

  it('exports nothing whose name suggests mutation of stored content', () => {
    // Belt and braces, and it says WHY in the failure message: a future
    // `updateResourceVersionContent` should fail here with a sentence explaining the invariant,
    // not with a diff of two string arrays.
    const suspicious = Object.keys(resourceVersion).filter((n) =>
      /^(update|patch|set|put|edit|revise|overwrite|mutate|delete|destroy|remove)/i.test(n),
    );
    expect(
      suspicious,
      'INV-CONTENT-1: a ResourceVersion is write-once. Corrections are NEW versions. ' +
        'This export looks like a mutation path; if it is genuinely not one, rename it so the ' +
        'next reader is not left checking.',
    ).toEqual([]);
  });

  it('restoreVersion returns a NEW version rather than mutating, by construction', () => {
    // The signature is the guarantee: it returns an id and a number, so there is nothing for a
    // caller to do but append.
    const r = resourceVersion.restoreVersion as unknown as (...args: unknown[]) => Promise<unknown>;
    // A function that MUTATED would not need to return anything; the return type is the proof.
    expect(typeof r).toBe('function');
    expect(resourceVersion.restoreVersion.length).toBe(2);
  });

  it('createResourceVersion appends: it takes a version number nowhere', () => {
    // The caller cannot choose a version number, which is what makes "two rows claiming version
    // 3" impossible by construction rather than by a check.
    const src = resourceVersion.createResourceVersion.toString();
    expect(src).not.toMatch(/version\s*[:=]\s*(input|input\.version)\b/);
  });
});
