/**
 * The simulation registry: `simId@version`, resolved.  (P6-T8)
 *
 * ## WHY THIS IS A SEPARATE PACKAGE AND NOT PART OF `@orrery/interop`
 *
 * Three consumers must agree on what `simId@2.1.0` means and what happens when it cannot be
 * resolved: the build CLI that emits it, the web host that mounts it, and the worker that grades
 * from stored state. If each had its own resolution rules then a pinned assignment resolved in the
 * browser and re-resolved in the worker could disagree — and the disagreement shows up as a student's
 * exam grading against a different simulation than they sat.
 *
 * So the rules live once, here, with no dependencies beyond the manifest schema.
 *
 * ## A REGISTRY IS A BUILD ARTEFACT, NOT A DATABASE EDIT
 *
 * `plans/10` §6: "Registration is a CI job, not a human database edit." So this registry is a plain
 * JSON document assembled from the built sims, and the only things a human can do to it are the four
 * lifecycle operations below — all of which are refusals plus a documented field change.
 *
 * ## DEPRECATED KEEPS SERVING, DISABLED DOES NOT — AND THE DIFFERENCE IS THE WHOLE DESIGN
 *
 * A live classroom must never break because somebody shipped a new version. So:
 *
 *  - `deprecated` + `replacedById` → still resolvable, still buildable, warns in authoring.
 *  - `DISABLED` (a security incident) → blocked at AUTHOR time, still resolvable for versions
 *    already PINNED, because the alternative is every student in the affected cohort losing their
 *    work at 09:00 on the day the decision was made.
 *
 * ## A MAJOR VERSION INVALIDATES STORED STATES, AND THE REGISTRY SAYS SO RATHER THAN GUESSING
 *
 * `plans/10` §9: a `MAJOR` change to the state or answer schema invalidates stored states. A pinned
 * `2.0.0` that is no longer built is a `VERSION_MISMATCH`, not a 404, and the host offers a safe reset
 * rather than loading a shape it does not understand.
 */

import { catalogueEntry, type SimManifest } from '@orrery/contracts/sim-manifest';
import { setDigest } from '@orrery/interop';

export type LifecycleState = 'ACTIVE' | 'DEPRECATED' | 'DISABLED';

export interface RegistryEntry {
  readonly id: string;
  readonly version: string;
  readonly lifecycle: LifecycleState;
  /** Required when `lifecycle` is `DEPRECATED`. */
  readonly replacedById: string | null;
  /** The declared licence, carried into the index because a catalogue has to display it. */
  readonly licence: string;
  /** Content-hashed, relative to the sim origin. Never an absolute URL. */
  readonly bundle: {
    /**
     * The DOCUMENT the iframe's `src` points at. Not the script.
     *
     * An iframe `src` performs a navigation, and navigating to a `text/javascript` resource makes the
     * browser render the source into a `<pre>`. A host that pointed `src` at `browser` got a frame with
     * a full page of source text in it and no simulation, which conformance found on its first run.
     */
    readonly page: string;
    readonly browser: string;
    readonly grader: string;
    readonly style: string | null;
  };
  readonly bytes: { readonly browser: number; readonly grader: number; readonly total: number };
  readonly defaultHeight: number;
  readonly minHeight: number;
  readonly parameters: readonly RegistryParam[];
}

export interface RegistryParam {
  readonly name: string;
  readonly type: string;
  readonly label: string;
  readonly unit: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly default: unknown;
}

export interface Registry {
  readonly generatedFrom: string;
  /** A change detector over every entry, so two builds of one tree produce the same digest. */
  readonly digest: string;
  readonly entries: readonly RegistryEntry[];
}

export type ResolutionFailure = 'UNKNOWN_SIM' | 'VERSION_MISMATCH' | 'DISABLED' | 'NOT_BUILT';

export type Resolution =
  | { readonly ok: true; readonly entry: RegistryEntry }
  | { readonly ok: false; readonly reason: ResolutionFailure; readonly message: string };

const key = (id: string, version: string): string => `${id}@${version}`;

/** `major` of a semver string, or `null` when the string is not one. */
export function majorOf(version: string): number | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-.]+)?$/u.exec(version);
  return match === null ? null : Number(match[1]);
}

/**
 * Build one registry entry from a manifest and its build output.
 *
 * The bundle paths are asserted to be RELATIVE and HASHED here rather than trusted. A registry that
 * could carry `https://evil.example/browser.js` would make the catalogue a delivery mechanism, and the
 * catalogue is fetched by every student in every lesson.
 */
export function entryFromManifest(
  manifest: SimManifest,
  built: {
    page: string;
    browser: string;
    grader: string;
    style: string | null;
    bytes: { browser: number; grader: number; total: number };
  },
): RegistryEntry {
  const hashed = /^\.\/[A-Za-z0-9._-]+\.[0-9a-f]{12}\.js$/u;
  // The PAGE is checked too, and it has to be a `.html` path. A registry that can carry an absolute
  // URL is a delivery mechanism, and the catalogue is fetched by every student in every lesson.
  const hashedPage = /^\.\/[A-Za-z0-9._-]+\.[0-9a-f]{12}\.html$/u;
  for (const [role, path, pattern] of [
    ['page', built.page, hashedPage],
    ['browser', built.browser, hashed],
    ['grader', built.grader, hashed],
  ] as const) {
    if (!pattern.test(path)) {
      throw new Error(
        `UNHASHED_${role.toUpperCase()}_PATH: "${path}" is not a content-hashed relative path. A ` +
          'registry that can carry an absolute URL is a delivery mechanism, and the catalogue is ' +
          'fetched by every student in every lesson.',
      );
    }
  }
  if (built.style !== null && !/^\.\/[A-Za-z0-9._-]+\.[0-9a-f]{12}\.css$/u.test(built.style)) {
    throw new Error(`UNHASHED_STYLE_PATH: "${built.style}" is not a content-hashed relative path.`);
  }

  const lifecycle: LifecycleState = manifest.deprecated ? 'DEPRECATED' : 'ACTIVE';
  if (lifecycle === 'DEPRECATED' && manifest.replacedById === undefined) {
    throw new Error(
      `DEPRECATED_WITHOUT_SUCCESSOR: ${manifest.id}@${manifest.version} is marked deprecated with ` +
        'no replacedById, so an author who opens it is told it is going away and not where to go.',
    );
  }

  return {
    id: manifest.id,
    version: manifest.version,
    lifecycle,
    replacedById: manifest.replacedById ?? null,
    licence: manifest.licence,
    bundle: {
      page: built.page,
      browser: built.browser,
      grader: built.grader,
      style: built.style,
    },
    bytes: built.bytes,
    defaultHeight: manifest.lifecycle.defaultHeight,
    minHeight: manifest.lifecycle.minHeight ?? manifest.lifecycle.defaultHeight,
    parameters: Object.entries(manifest.params.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
      // The manifest REQUIRES the label and `simManifestSchema` enforces it, so this fallback is
      // defensive rather than reachable — the SDK does not require a label because a sim author writes
      // physics, and the manifest does require it because the host editor renders it.
      label: prop.label ?? name,
      unit: prop.unit ?? null,
      minimum: typeof prop.minimum === 'number' ? prop.minimum : null,
      maximum: typeof prop.maximum === 'number' ? prop.maximum : null,
      step: typeof prop.step === 'number' ? prop.step : null,
      default: prop.default,
    })),
  };
}

export function buildRegistry(entries: readonly RegistryEntry[], generatedFrom: string): Registry {
  // Sorted, and hashed over the SORTED set, so the digest is a property of the content rather than of
  // the order the filesystem happened to return. An order-dependent digest makes every rebuild look
  // like a change, and a change detector that always fires is one people learn to ignore.
  const sorted = [...entries].sort((a, b) =>
    key(a.id, a.version) < key(b.id, b.version) ? -1 : 1,
  );
  const duplicates = sorted.filter(
    (entry, i) =>
      i > 0 &&
      key(sorted[i - 1]?.id ?? '', sorted[i - 1]?.version ?? '') === key(entry.id, entry.version),
  );
  if (duplicates.length > 0) {
    throw new Error(
      `DUPLICATE_REGISTRY_ENTRY: ${duplicates.map((e) => key(e.id, e.version)).join(', ')}`,
    );
  }
  return {
    generatedFrom,
    digest: setDigest(sorted),
    entries: sorted,
  };
}

// ───────────────────────────────────────────────── resolution

export interface ResolveOptions {
  /**
   * Whether the caller is an AUTHOR picking a sim, or a RESOURCE already pinned to one.
   *
   * The distinction is the whole of the `DISABLED` rule: a disabled version is still resolvable for a
   * pinned resource, because the alternative is a student losing their exam.
   */
  readonly pinned: boolean;
}

/**
 * Resolve `simId@version` — or `simId` alone, which means the newest `ACTIVE` version.
 *
 * ## "NEWEST" MEANS HIGHEST MINOR, AND A PRERELEASE NEVER WINS
 *
 * A prerelease is somebody's draft. If `2.0.0-rc.1` could win an unpinned resolution, a merge that
 * adds a simulation immediately serves a draft to every student in every lesson, with no flag and no
 * review. So a prerelease is only ever returned when the pin asks for it by exact version.
 *
 * ## A PIN THAT DOES NOT EXIST IS `VERSION_MISMATCH`, NOT `UNKNOWN_SIM`
 *
 * The distinction matters to the host: `UNKNOWN_SIM` is a broken lesson, and `VERSION_MISMATCH` is a
 * stored state that no longer matches its simulation. The second gets a safe reset; the first gets a
 * static fallback and a warning for whoever wrote the lesson.
 */
export function resolve(
  registry: Registry,
  simId: string,
  version: string | null,
  options: ResolveOptions,
): Resolution {
  const forId = registry.entries.filter((entry) => entry.id === simId);
  if (forId.length === 0) {
    return {
      ok: false,
      reason: 'UNKNOWN_SIM',
      message: `${simId} is not in this registry. A lesson is never broken by a registry problem, so the static fallback shows.`,
    };
  }

  if (version === null) {
    const candidates = forId
      .filter((entry) => entry.lifecycle === 'ACTIVE')
      .filter((entry) => (majorOf(entry.version) ?? 0) >= 0 && !entry.version.includes('-'))
      .sort((a, b) => compareVersions(b.version, a.version));
    const newest = candidates[0];
    if (newest === undefined) {
      // Every version is either DISABLED, DEPRECATED, or a prerelease. Saying UNKNOWN_SIM here was
      // wrong in a specific and unhelpful way: the sim IS known, it was switched off, and a teacher
      // told "not in this registry" goes looking for a typo instead of reading the security note.
      const disabled = forId.find((candidate) => candidate.lifecycle === 'DISABLED');
      if (disabled !== undefined) {
        return {
          ok: false,
          reason: 'DISABLED',
          message:
            `${simId} is disabled. It may still resolve for a resource already pinned to it, ` +
            'because disabling must not empty a live classroom.',
        };
      }
      const prereleases = forId.filter((candidate) => candidate.version.includes('-'));
      return {
        ok: false,
        reason: 'UNKNOWN_SIM',
        message:
          prereleases.length > 0
            ? `${simId} has only PRERELEASE versions, and a draft is never served unpinned. Pin an exact version to test it.`
            : `${simId} has no ACTIVE stable version, so there is nothing to serve unpinned.`,
      };
    }
    return { ok: true, entry: newest };
  }

  const exact = forId.find((entry) => entry.version === version);
  if (exact === undefined) {
    const available = forId.map((entry) => entry.version).join(', ') || 'none';
    return {
      ok: false,
      reason: 'VERSION_MISMATCH',
      message:
        `${simId}@${version} is pinned but the registry holds ${available}. Stored states from that ` +
        'version have a different shape, so they are kept rather than loaded.',
    };
  }
  if (exact.lifecycle === 'DISABLED' && !options.pinned) {
    return {
      ok: false,
      reason: 'DISABLED',
      message:
        `${simId}@${version} is disabled and this is not a pinned resource. It may still resolve for a ` +
        'resource already pointing at it, because disabling must not empty a live classroom.',
    };
  }
  return { ok: true, entry: exact };
}

/** Compare two semver strings. Numeric where possible, lexicographic for prerelease tags. */
function compareVersions(a: string, b: string): number {
  const [aCore = '', aPre = ''] = a.split('-');
  const [bCore = '', bPre = ''] = b.split('-');
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release outranks any prerelease of the same version, which is the semver rule and also the
  // safety rule.
  if (aPre === bPre) return 0;
  if (aPre === '') return 1;
  if (bPre === '') return -1;
  return aPre < bPre ? -1 : 1;
}

/**
 * Would replacing `from` with `to` invalidate the stored states a student is holding?
 *
 * `MAJOR` means the state or answer schema changed (`plans/10` §9), so the answer is yes. The host
 * offers a safe reset rather than loading a shape it does not understand, and the registry is what
 * tells it to ask.
 */
export function wouldInvalidateStates(from: string, to: string): boolean {
  const fromMajor = majorOf(from);
  const toMajor = majorOf(to);
  if (fromMajor === null || toMajor === null) return true;
  return fromMajor !== toMajor;
}

// ───────────────────────────────────────────────── the catalogue index

export interface CatalogueEntry {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  readonly subjects: readonly string[];
  readonly tags: readonly string[];
  readonly ageRange: readonly [number, number];
  readonly screenReaderSummary: string;
  readonly textAlternative: string;
  readonly licence: string;
  readonly lifecycle: LifecycleState;
  readonly replacedById: string | null;
  readonly bytes: number;
  readonly defaultHeight: number;
}

/**
 * The catalogue index, and it carries NO BUNDLE PATH.
 *
 * `plans/10` §9: "the catalogue fetches a metadata index, never code". So this projection is the
 * enforcement, not a promise: an entry here has no field a bundle URL could go in, so a catalogue page
 * cannot be used to load a simulation even by accident.
 */
export function catalogueIndex(
  registry: Registry,
  manifests: ReadonlyMap<string, SimManifest>,
): readonly CatalogueEntry[] {
  return registry.entries.map((entry) => {
    const manifest = manifests.get(key(entry.id, entry.version));
    if (manifest === undefined) {
      throw new Error(
        `MANIFEST_MISSING_FOR_ENTRY: ${key(entry.id, entry.version)} is in the registry with no manifest`,
      );
    }
    const base = catalogueEntry(manifest);
    return {
      id: base.id,
      version: entry.version,
      title: base.title,
      summary: base.summary,
      subjects: base.subjects,
      tags: base.tags,
      ageRange: base.ageRange,
      screenReaderSummary: base.screenReaderSummary,
      textAlternative: base.textAlternative,
      licence: entry.licence,
      lifecycle: entry.lifecycle,
      replacedById: entry.replacedById,
      bytes: entry.bytes.total,
      defaultHeight: entry.defaultHeight,
    };
  });
}

/**
 * The deployed URL for one artefact.
 *
 * ## THE REGISTRY'S BUNDLE PATHS ARE RELATIVE TO THE SIM'S OWN DIRECTORY
 *
 * `bundle.browser` is `./browser.<hash>.js`, which is meaningless without knowing what it is relative
 * to. It is relative to the sim's deployment directory — `<simId>/<version>/` — not to the registry.
 * The conformance suite found this the hard way: it served bundles out of the registry directory and
 * every simulation 404'd, with an error that looked like a broken bundle rather than a wrong base.
 *
 * So the composition lives here, once, rather than being re-derived by the host, the catalogue and the
 * conformance runner — which is three places to drift.
 *
 * @param trailingSlash Whether `origin` ends with a slash. Tolerated rather than assumed, because a
 *   doubled slash is a 404 that presents as a broken deployment.
 */
export function simAssetUrl(
  origin: string,
  entry: Pick<RegistryEntry, 'id' | 'version' | 'bundle'>,
  role: keyof RegistryEntry['bundle'],
): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  const file = entry.bundle[role];
  if (file === null) {
    throw new Error(`${entry.id}@${entry.version} publishes no ${role} artefact`);
  }
  const relative = file.replace(/^\.\//, '');
  return `${base}/${entry.id}/${entry.version}/${relative}`;
}
