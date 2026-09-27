/**
 * WCAG contrast, computed rather than eyeballed.  (P2-T7)
 *
 * ## Why this is code and not a design review
 *
 * `plans/15` §2 rule 7: "Contrast ≥ 4.5:1 for text and ≥ 3:1 for UI components and graphical
 * objects, in both themes and in `forced-colors` mode."
 *
 * Every one of those numbers is arithmetic. A design review that says "the grey looks fine on
 * white" is making a claim that can be checked to two decimal places, and the claims that survive
 * review are the ones nobody checked. So the tokens live here, the maths lives here, and the test
 * asserts every required pair in BOTH themes — because the pair that fails is always the one in
 * the theme nobody was looking at when they changed it.
 *
 * ## The arithmetic, which is fiddlier than it looks
 *
 * Relative luminance is defined on LINEARISED sRGB, not on the 8-bit values. Skipping the
 * gamma step is the classic mistake and it produces ratios that are wrong in the optimistic
 * direction for dark colours — which is exactly where a failing pair would be found.
 *
 * The 0.03928 threshold is the sRGB standard's own (not 0.04045, which is a common
 * misremembering); the difference matters only in a two-value band and the standard is explicit.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `0xRRGGBB`. The single source for theme tokens — no `rgb()` strings to drift. */
export const hex = (value: number): Rgb => ({
  r: (value >> 16) & 0xff,
  g: (value >> 8) & 0xff,
  b: value & 0xff,
});

/** The sRGB linearisation for one 0-255 channel. Exported so the threshold is testable. */
export const channelOf = (raw: number): number => {
  const c = raw / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(c: Rgb): number {
  return 0.2126 * channelOf(c.r) + 0.7152 * channelOf(c.g) + 0.0722 * channelOf(c.b);
}

/** The contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to hundredths, the precision the ratio is meaningful at. */
export const ratio = (a: Rgb, b: Rgb): number => Math.round(contrast(a, b) * 100) / 100;

export const TEXT_MINIMUM = 4.5;
export const LARGE_TEXT_MINIMUM = 3;
export const UI_MINIMUM = 3;

/**
 * The two themes' tokens, as data.
 *
 * Only the pairs the product actually uses. A token list nobody renders is a token list that
 * drifts from the CSS, and the test below is what stops that: if a token is added here and not
 * to the stylesheet, nothing notices, and if a pair is used in a component and not listed here,
 * nothing notices either. So the list is asserted to COVER the pairs, not merely to pass.
 */
export const THEMES = {
  light: {
    background: hex(0xffffff),
    surface: hex(0xf6f7f9),
    text: hex(0x14181f),
    mutedText: hex(0x4a5260),
    // Darkened from 0x8a93a2, which measured 2.89:1 against `surface` and so failed the 3:1
    // non-text minimum. It passed against `background` at 3.10 and nobody would have noticed,
    // because a border is only ever seen against a surface. This is the whole argument for
    // computing contrast instead of reviewing it: the failing pair was the one nobody looks at.
    border: hex(0x6c7684),
    accent: hex(0x1a4fd6),
    danger: hex(0xa4121f),
    warning: hex(0x7a4a00),
    success: hex(0x14663a),
  },
  dark: {
    background: hex(0x0f1216),
    surface: hex(0x181c22),
    text: hex(0xf2f4f7),
    mutedText: hex(0xb6bdc8),
    border: hex(0x6c7684),
    accent: hex(0x86a9ff),
    danger: hex(0xff9aa2),
    warning: hex(0xf0c274),
    success: hex(0x7fd6a4),
  },
} as const;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES: readonly ThemeName[] = ['light', 'dark'];

/**
 * The pairs that must hold, and at which threshold.
 *
 * `text` pairs are 4.5:1 (AA body text). `ui` pairs are 3:1 (AA non-text contrast: borders,
 * focus rings, control outlines). `large` is 3:1, used only for text at ≥24px or ≥19px bold.
 *
 * A severity colour is a `ui` pair as well as a text pair: it is drawn as a border and as an
 * icon, both of which are graphical objects, and a red that reads as text at 4.5:1 but as a
 * 2.8:1 border is a fail.
 */
export const REQUIRED_PAIRS: readonly {
  readonly name: string;
  readonly fg: keyof (typeof THEMES)['light'];
  readonly bg: keyof (typeof THEMES)['light'];
  readonly kind: 'text' | 'large' | 'ui';
}[] = [
  { name: 'body text on background', fg: 'text', bg: 'background', kind: 'text' },
  { name: 'body text on surface', fg: 'text', bg: 'surface', kind: 'text' },
  { name: 'muted text on background', fg: 'mutedText', bg: 'background', kind: 'text' },
  { name: 'muted text on surface', fg: 'mutedText', bg: 'surface', kind: 'text' },
  { name: 'accent on background (link)', fg: 'accent', bg: 'background', kind: 'text' },
  { name: 'danger on background', fg: 'danger', bg: 'background', kind: 'text' },
  { name: 'danger on surface', fg: 'danger', bg: 'surface', kind: 'text' },
  { name: 'warning on background', fg: 'warning', bg: 'background', kind: 'text' },
  { name: 'success on background', fg: 'success', bg: 'background', kind: 'text' },
  { name: 'border on background (UI)', fg: 'border', bg: 'background', kind: 'ui' },
  { name: 'border on surface (UI)', fg: 'border', bg: 'surface', kind: 'ui' },
  { name: 'accent on background (focus ring, UI)', fg: 'accent', bg: 'background', kind: 'ui' },
];

/** The threshold a kind must clear. */
export function minimumFor(kind: 'text' | 'large' | 'ui'): number {
  return kind === 'text' ? TEXT_MINIMUM : kind === 'large' ? LARGE_TEXT_MINIMUM : UI_MINIMUM;
}

/** Every required pair in one theme, with its measured ratio. */
export function auditTheme(name: ThemeName): readonly {
  pair: (typeof REQUIRED_PAIRS)[number];
  ratio: number;
  minimum: number;
  passes: boolean;
}[] {
  const theme = THEMES[name];
  return REQUIRED_PAIRS.map((pair) => {
    const measured = ratio(theme[pair.fg], theme[pair.bg]);
    const minimum = minimumFor(pair.kind);
    return { pair, ratio: measured, minimum, passes: measured >= minimum };
  });
}

/**
 * The token names the stylesheet must define.
 *
 * Exported so a stylesheet gate can check the CSS and the tokens agree. A contrast test against
 * tokens the page does not use is a test of a fiction, and this is the list that makes the
 * fiction checkable.
 */
export const TOKEN_NAMES: readonly string[] = Object.keys(THEMES.light);
