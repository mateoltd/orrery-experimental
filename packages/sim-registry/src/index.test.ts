/**
 * The registry.  (P6-T8)
 *
 * ## THE TESTS THAT MATTER MOST
 *
 *  · `a PRERELEASE NEVER WINS an unpinned resolution` — a merge that adds a simulation must not serve a
 *    draft to every student in every lesson, with no flag and no review.
 *  · `a DISABLED version still resolves for a PINNED resource` — disabling must not empty a live
 *    classroom, and the alternative is a student losing their exam on the day the decision was made.
 *  · `a pin that does not exist is VERSION_MISMATCH, not UNKNOWN_SIM` — the host gives the second a safe
 *    reset and the first a static fallback, and the distinction is what tells it which.
 *  · `the catalogue index has NO FIELD a bundle path could go in` — structural, not a promise.
 */
import { type SimManifest, simManifestSchema } from '@orrery/contracts/sim-manifest';
import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  type CatalogueEntry,
  catalogueIndex,
  entryFromManifest,
  majorOf,
  type Registry,
  type RegistryEntry,
  resolve,
  wouldInvalidateStates,
} from './index.js';

/** The RAW object, unparsed — needed by the tests that assert the schema REJECTS something. */
const rawManifest = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'maths.projectile-motion',
  version: '1.0.0',
  title: 'Projectile motion',
  summary: 'Explore how launch speed and angle change the range and flight time of a thrown ball.',
  licence: 'CC-BY-4.0',
  provenance: 'ORIGINAL',
  protocol: 1,
  subjects: ['maths'],
  tags: ['kinematics'],
  ageRange: [13, 18],
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A side view of a thrown ball, with the ground, its path and a range marker.',
    reducedMotion: true,
    textAlternative: 'At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds.',
  },
  entry: './browser.js',
  grader: './grader.js',
  styles: './style.css',
  budget: { maxBytes: 350_000 },
  params: {
    type: 'object',
    properties: {
      speed: {
        type: 'number',
        label: 'Launch speed',
        unit: 'm/s',
        minimum: 5,
        maximum: 60,
        default: 25,
      },
      angle: {
        type: 'number',
        label: 'Launch angle',
        unit: 'degrees',
        minimum: 5,
        maximum: 85,
        default: 45,
      },
    },
    required: ['speed', 'angle'],
  },
  capabilities: {
    state: true,
    grading: true,
    randomised: false,
    audio: false,
    webgl: false,
    stepper: true,
    scenarios: [],
  },
  stateSchema: { type: 'object' },
  answerSchema: { type: 'object' },
  grading: {
    strategy: 'TOLERANCE',
    maxPoints: 4,
    tolerance: { absolute: 0.5 },
    partialCredit: true,
  },
  lifecycle: { autoPlay: false, defaultHeight: 420, minHeight: 240 },
  ...over,
});

const manifestFor = (over: Partial<Record<string, unknown>> = {}): SimManifest =>
  simManifestSchema.parse(rawManifest(over));

const built = {
  page: './sim.0123456789ab.html',
  browser: './browser.f0287dafca92.js',
  grader: './grader.eee091640f4a.js',
  style: './style.dec5ddce6f96.css',
  bytes: { browser: 11_773, grader: 6_018, total: 18_409 },
};

const entry = (id: string, version: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id,
  version,
  lifecycle: 'ACTIVE',
  replacedById: null,
  licence: 'CC-BY-4.0',
  bundle: {
    page: './sim.0123456789ab.html',
    browser: './browser.f0287dafca92.js',
    grader: './grader.eee091640f4a.js',
    style: './style.dec5ddce6f96.css',
  },
  bytes: { browser: 11_773, grader: 6_018, total: 18_409 },
  defaultHeight: 420,
  minHeight: 240,
  parameters: [],
  ...over,
});

const registryOf = (entries: readonly RegistryEntry[]): Registry => buildRegistry(entries, 'test');

describe('building an entry', () => {
  it('takes the bundle paths from the BUILD, and refuses anything unhashed or absolute', () => {
    // A registry that could carry `https://evil.example/browser.js` would make the catalogue a
    // delivery mechanism, and the catalogue is fetched by every student in every lesson.
    expect(() =>
      entryFromManifest(manifestFor(), { ...built, browser: 'https://evil.example/browser.js' }),
    ).toThrow(/UNHASHED_BROWSER_PATH/);
    expect(() => entryFromManifest(manifestFor(), { ...built, grader: './grader.js' })).toThrow(
      /UNHASHED_GRADER_PATH/u,
    );
    expect(() => entryFromManifest(manifestFor(), { ...built, style: './style.css' })).toThrow(
      /UNHASHED_STYLE_PATH/u,
    );
    // A `../` escape is equally unacceptable, and the hash pattern alone already refuses it.
    expect(() =>
      entryFromManifest(manifestFor(), {
        ...built,
        browser: './../../etc/browser.0123456789ab.js',
      }),
    ).toThrow(/UNHASHED_BROWSER_PATH/u);
  });

  it('carries the parameters the host editor needs, in manifest order of declaration', () => {
    const result = entryFromManifest(manifestFor(), built);
    expect(result.parameters.map((p) => p.name)).toEqual(['speed', 'angle']);
    expect(result.parameters[0]).toEqual({
      name: 'speed',
      type: 'number',
      label: 'Launch speed',
      unit: 'm/s',
      minimum: 5,
      maximum: 60,
      step: null,
      default: 25,
    });
  });

  it('the MANIFEST requires the label even though the SDK does not', () => {
    // The SDK deliberately omits it -- `plans/10` §4's own example has none -- because a sim author
    // writes physics; the manifest requires it because the host's parameter editor renders it. So the
    // `label: prop.label ?? name` in the entry builder is DEFENSIVE rather than reachable, and this
    // asserts the real enforced behaviour instead of testing the fallback as though it were the path.
    // `rawManifest`, not `manifestFor`: the fixture PARSES, so asking it to produce an invalid
    // manifest throws before `safeParse` is ever reached.
    const result = simManifestSchema.safeParse(
      rawManifest({
        params: {
          type: 'object',
          properties: { speed: { type: 'number', minimum: 5, maximum: 60, default: 25 } },
        },
      }),
    );
    expect(result.success, 'a param with no label should be refused by the manifest').toBe(false);
    expect(entryFromManifest(manifestFor(), built).parameters[0]?.label).toBe('Launch speed');
  });

  it('refuses a DEPRECATED entry with no successor', () => {
    // An author who opens it is told it is going away and not where to go.
    expect(() => entryFromManifest(manifestFor({ deprecated: true }), built)).toThrow(
      /DEPRECATED_WITHOUT_SUCCESSOR/u,
    );
  });

  it('a deprecation WITH a successor is DEPRECATED, not removed', () => {
    const result = entryFromManifest(
      manifestFor({ deprecated: true, replacedById: 'maths.projectile-motion-2' }),
      built,
    );
    expect(result.lifecycle).toBe('DEPRECATED');
    expect(result.replacedById).toBe('maths.projectile-motion-2');
  });
});

describe('the registry digest', () => {
  it('is a property of the CONTENT, not of the order the filesystem returned', () => {
    // An order-dependent digest makes every rebuild look like a change, and a change detector that
    // always fires is one people learn to ignore.
    const a = registryOf([entry('maths.b', '1.0.0'), entry('maths.a', '1.0.0')]);
    const b = registryOf([entry('maths.a', '1.0.0'), entry('maths.b', '1.0.0')]);
    expect(a.digest).toBe(b.digest);
    expect(a.entries.map((e) => e.id)).toEqual(['maths.a', 'maths.b']);
  });

  it('changes when an entry changes', () => {
    const before = registryOf([entry('maths.a', '1.0.0')]);
    const after = registryOf([
      entry('maths.a', '1.0.0', { bytes: { browser: 1, grader: 1, total: 2 } }),
    ]);
    expect(before.digest).not.toBe(after.digest);
  });

  it('refuses a DUPLICATE id@version', () => {
    expect(() => registryOf([entry('maths.a', '1.0.0'), entry('maths.a', '1.0.0')])).toThrow(
      /DUPLICATE_REGISTRY_ENTRY/u,
    );
  });

  it('allows the same id at SEVERAL versions, which is the point of the registry', () => {
    const registry = registryOf([entry('maths.a', '1.0.0'), entry('maths.a', '2.0.0')]);
    expect(registry.entries).toHaveLength(2);
  });
});

describe('resolution', () => {
  const registry = registryOf([
    entry('maths.projectile-motion', '1.0.0'),
    entry('maths.projectile-motion', '1.2.0'),
    entry('maths.projectile-motion', '2.0.0'),
    entry('maths.projectile-motion', '2.1.0-rc.1'),
    entry('maths.projectile-motion', '1.1.0', {
      lifecycle: 'DEPRECATED',
      replacedById: 'maths.projectile-motion',
    }),
    entry('maths.retired', '1.0.0', { lifecycle: 'DISABLED' }),
  ]);

  it('an unpinned reference gets the newest ACTIVE STABLE version', () => {
    const result = resolve(registry, 'maths.projectile-motion', null, { pinned: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.version).toBe('2.0.0');
  });

  it('a PRERELEASE never wins an unpinned resolution', () => {
    // A merge that adds a simulation immediately serves a draft to every student in every lesson, with
    // no flag and no review.
    const withOnlyPrerelease = registryOf([entry('maths.new', '1.0.0-rc.1')]);
    expect(resolve(withOnlyPrerelease, 'maths.new', null, { pinned: false }).ok).toBe(false);
    // And it is still reachable by an exact pin, which is how you test it.
    expect(resolve(withOnlyPrerelease, 'maths.new', '1.0.0-rc.1', { pinned: true }).ok).toBe(true);
  });

  it('a DEPRECATED version is not the newest-active answer, because it is not ACTIVE', () => {
    const result = resolve(registry, 'maths.projectile-motion', null, { pinned: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.lifecycle).toBe('ACTIVE');
  });

  it('a DEPRECATED version STILL RESOLVES when pinned, because a live classroom must not break', () => {
    const result = resolve(registry, 'maths.projectile-motion', '1.1.0', { pinned: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.lifecycle).toBe('DEPRECATED');
  });

  it('a DISABLED version is refused for an AUTHOR and allowed for a PINNED resource', () => {
    // The alternative to allowing it is every student in the affected cohort losing their work at 09:00
    // on the day the decision was made.
    const author = resolve(registry, 'maths.retired', null, { pinned: false });
    expect(author.ok).toBe(false);
    if (!author.ok) expect(author.reason).toBe('DISABLED');
    expect(resolve(registry, 'maths.retired', '1.0.0', { pinned: true }).ok).toBe(true);
  });

  it('an UNKNOWN sim is UNKNOWN_SIM, and the message says the lesson is not broken', () => {
    const result = resolve(registry, 'maths.nope', null, { pinned: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('UNKNOWN_SIM');
      expect(result.message).toMatch(/never broken/u);
    }
  });

  it('a pin that does not exist is VERSION_MISMATCH, NOT UNKNOWN_SIM', () => {
    // The host gives a VERSION_MISMATCH a safe reset and an UNKNOWN_SIM a static fallback, and the
    // distinction is what tells it which.
    const result = resolve(registry, 'maths.projectile-motion', '9.9.9', { pinned: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('VERSION_MISMATCH');
      // And it lists what IS there, because "not found" is not something a teacher can act on.
      expect(result.message).toMatch(/1\.0\.0, 1\.1\.0, 1\.2\.0, 2\.0\.0/u);
      expect(result.message).toMatch(/kept rather than loaded/u);
    }
  });

  it('resolves semver correctly, including MINOR and PRERELEASE ordering', () => {
    const result = resolve(registry, 'maths.projectile-motion', '2.0.0', { pinned: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.version).toBe('2.0.0');
    expect(majorOf('2.1.0-rc.1')).toBe(2);
    expect(majorOf('not a version')).toBeNull();
  });
});

describe('state invalidation', () => {
  it('a MAJOR change invalidates stored states, because the schema changed', () => {
    expect(wouldInvalidateStates('1.9.0', '2.0.0')).toBe(true);
    expect(wouldInvalidateStates('2.0.0', '2.1.0')).toBe(false);
    expect(wouldInvalidateStates('1.0.0', '1.0.0')).toBe(false);
  });

  it('an unparseable version invalidates, because guessing would corrupt a grade', () => {
    expect(wouldInvalidateStates('nonsense', '1.0.0')).toBe(true);
    expect(wouldInvalidateStates('1.0.0', 'nonsense')).toBe(true);
  });
});

describe('the catalogue index', () => {
  it('carries NO FIELD a bundle path could go in', () => {
    // `plans/10` §9: "the catalogue fetches a metadata index, never code". This projection is the
    // enforcement rather than a promise.
    const manifest = manifestFor();
    const registry = registryOf([entryFromManifest(manifest, built)]);
    const index = catalogueIndex(
      registry,
      new Map([[`${manifest.id}@${manifest.version}`, manifest]]),
    );
    expect(index).toHaveLength(1);
    const only = index[0] as CatalogueEntry;
    expect(Object.keys(only).sort()).toEqual([
      'ageRange',
      'bytes',
      'defaultHeight',
      'id',
      'licence',
      'lifecycle',
      'replacedById',
      'screenReaderSummary',
      'subjects',
      'summary',
      'tags',
      'textAlternative',
      'title',
      'version',
    ]);
    expect(JSON.stringify(index)).not.toMatch(/browser\.|grader\./u);
  });

  it('carries the TEXT ALTERNATIVE and the SCREEN READER SUMMARY, because that is why a catalogue exists', () => {
    const manifest = manifestFor();
    const registry = registryOf([entryFromManifest(manifest, built)]);
    const only = catalogueIndex(
      registry,
      new Map([[`${manifest.id}@${manifest.version}`, manifest]]),
    )[0];
    expect(only?.textAlternative).toMatch(/lands about 64 m/u);
    expect(only?.screenReaderSummary).toMatch(/side view/u);
  });

  it('carries the LICENCE, because a catalogue is where someone checks what they may reuse', () => {
    const manifest = manifestFor();
    const registry = registryOf([entryFromManifest(manifest, built)]);
    const only = catalogueIndex(
      registry,
      new Map([[`${manifest.id}@${manifest.version}`, manifest]]),
    )[0];
    expect(only?.licence).toBe('CC-BY-4.0');
  });

  it('refuses an entry with no manifest, rather than emitting an index with a hole in it', () => {
    const registry = registryOf([entry('maths.ghost', '1.0.0')]);
    expect(() => catalogueIndex(registry, new Map())).toThrow(/MANIFEST_MISSING_FOR_ENTRY/u);
  });
});
