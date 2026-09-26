/**
 * The sanctioned embed providers.  (P2-T1 do-5, plans/05 §2.2)
 *
 * ## This is a CLOSED SET, and that is the security property
 *
 * `embedExternal` has **no URL field**. An author picks a provider and supplies only an
 * identifier, and the URL is built here from a fixed template. There is nowhere for a user to
 * put `javascript:`, `data:`, an internal hostname, or their own phishing domain, because the
 * field does not exist.
 *
 * The tempting design is `{ provider, url }` with a validation regex. That is wrong for a
 * structural reason rather than a filtering one: a regex is a denylist of everything the author
 * thought of, and the next provider, the next scheme, or the next redirect is a bypass. Here
 * the reachable set of origins is enumerable by reading this file, and the gate can assert its
 * size.
 *
 * ## Per-provider frame CSP
 *
 * Each entry carries the `frame-src` the embedded frame needs. A provider that needs nothing
 * beyond its own origin says so, and the test asserts no entry's CSP names an origin absent from
 * its own template — because a CSP that permits an origin the provider does not serve is a
 * hole typed into the allowlist itself.
 */

/** A vetted provider. `template` is the ONLY way a URL for it is ever built. */
export interface EmbedProvider {
  readonly id: string;
  /** Human label for the editor's provider picker. */
  readonly label: string;
  /**
   * Builds the URL from an identifier.
   *
   * Total, and total means it always returns something. A provider whose builder can throw on
   * a malformed identifier is a 500 in the renderer, which is a denial of service on a content
   * page.
   */
  readonly template: (id: string) => string;
  /** The origins this provider's frame is permitted to load from. */
  readonly frameOrigins: readonly string[];
  /** Providers that set cookies or run scripts get a sandbox that reflects it. */
  readonly sandbox: readonly string[];
  /** Whether the provider needs a Referrer-Policy, which most do. */
  readonly referrerPolicy: 'strict-origin-when-cross-origin' | 'no-referrer';
  /**
   * A preview image, so the author sees something before the third party loads. Also the thing
   * that renders in a blocked region, which is a real state for this audience.
   */
  readonly previewImageTemplate: (id: string) => string;
}

const VIMEO: EmbedProvider = {
  id: 'vimeo',
  label: 'Vimeo',
  template: (id) => `https://player.vimeo.com/video/${encodeURIComponent(id)}`,
  frameOrigins: ['https://player.vimeo.com'],
  sandbox: ['allow-scripts', 'allow-same-origin', 'allow-presentation'],
  referrerPolicy: 'strict-origin-when-cross-origin',
  previewImageTemplate: (id) => `https://vumbnail.com/${encodeURIComponent(id)}_medium.jpg`,
};

const YOUTUBE: EmbedProvider = {
  id: 'youtube',
  label: 'YouTube',
  // `youtube-nocookie.com`, deliberately. The `youtube.com` embed sets a persistent cookie for
  // every student who opens a lesson, which in a school means a tracking identifier on every
  // child in the year group, from a site nobody chose.
  template: (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
  frameOrigins: ['https://www.youtube-nocookie.com'],
  // No `allow-same-origin`: it is not needed to play a video, and it is what a sandbox escape
  // would need. Deliberately more restrictive than the obvious configuration.
  sandbox: ['allow-scripts', 'allow-presentation'],
  referrerPolicy: 'strict-origin-when-cross-origin',
  previewImageTemplate: (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`,
};

const WIDGET: EmbedProvider = {
  id: 'desmos',
  label: 'Desmos Graphing Calculator',
  template: (id) => `https://www.desmos.com/calculator/${encodeURIComponent(id)}`,
  frameOrigins: ['https://www.desmos.com'],
  sandbox: ['allow-scripts', 'allow-same-origin'],
  referrerPolicy: 'strict-origin-when-cross-origin',
  previewImageTemplate: () => 'https://www.desmos.com/favicon.ico',
};

export const PROVIDERS: Readonly<Record<string, EmbedProvider>> = Object.freeze({
  vimeo: VIMEO,
  youtube: YOUTUBE,
  desmos: WIDGET,
});

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ReadonlyArray<keyof typeof PROVIDERS>;

/** Look up a provider, or null. Null rather than a throw: an unknown provider is a validation
 *  error the caller reports, not an exception during rendering. */
export function providerFor(id: string): EmbedProvider | null {
  return Object.hasOwn(PROVIDERS, id) ? (PROVIDERS[id as keyof typeof PROVIDERS] ?? null) : null;
}

/** Every origin any provider's frame may load. The complete reachable set, in one array. */
export function allFrameOrigins(): string[] {
  return Object.values(PROVIDERS).flatMap((p) => [...p.frameOrigins]);
}

/**
 * The `frame-src` value for a provider. Appended to the app's own CSP, which always allows
 * `self` and the sim origin.
 */
export function frameSrcFor(provider: EmbedProvider): string {
  return provider.frameOrigins.join(' ');
}
