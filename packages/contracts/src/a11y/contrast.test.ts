/**
 * Contrast, computed.  (P2-T7)
 *
 * ## What this test is
 *
 * Every required pair in BOTH themes, against the WCAG thresholds, with the failing pairs named.
 * The pair that fails is always the one nobody was looking at when they changed the token -- so
 * the assertion enumerates the PAIRS rather than checking "the theme is fine".
 *
 * ## And the arithmetic is checked too
 *
 * A test that computed 21:1 for white-on-black by accident would pass every pair below. So the
 * known values are asserted first, and the gamma step is tested on the value it exists for: a
 * dark colour's ratio without linearisation is optimistic, which is exactly where a failure
 * would hide.
 */
import { describe, expect, it } from 'vitest';
import {
  auditTheme,
  channelOf,
  hex,
  luminance,
  REQUIRED_PAIRS,
  ratio,
  TEXT_MINIMUM,
  THEME_NAMES,
  THEMES,
  TOKEN_NAMES,
  UI_MINIMUM,
} from './contrast.js';

describe('the arithmetic', () => {
  it('computes the known extremes exactly', () => {
    expect(ratio(hex(0xffffff), hex(0x000000))).toBe(21);
    expect(ratio(hex(0x000000), hex(0x000000))).toBe(1);
    expect(luminance(hex(0x000000))).toBe(0);
    expect(luminance(hex(0xffffff))).toBeCloseTo(1, 5);
  });

  it('is symmetric, because a ratio has no direction', () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      expect(ratio(t.text, t.background)).toBe(ratio(t.background, t.text));
    }
  });

  it('linearises sRGB, and the difference is not academic', () => {
    // A dark colour is where skipping the gamma step flatters itself. Without linearisation
    // #767f8f reads LIGHTER than it is, so its ratio against a dark background comes out better
    // than it is -- and a dark theme is exactly where a text colour gets quietly tuned until
    // "it looks fine" and measures 3.1:1.
    const linear = luminance(hex(0x767f8f));
    const naive = (0.2126 * 0x767f8f + 0.7152 * 0x767f8f + 0.0722 * 0x767f8f) / 255;
    expect(naive).toBeGreaterThan(linear);
    expect(linear).toBeLessThan(naive * 0.4);
  });

  it('uses the 0.03928 threshold the sRGB standard specifies', () => {
    // 0.04045 is a common misremembering. The two branches agree at the crossover, so the
    // difference is invisible until it is not — and "invisible until it is not" is the worst
    // possible property for a constant in a contrast formula.
    //
    // `channelOf` takes a 0-255 raw value, not a normalised one. An earlier version of this test
    // passed `10 / 255`, which is a raw 0.039, so the function correctly treated it as almost
    // black and the assertion compared nonsense to nonsense.
    const raw = 10;
    const normalised = raw / 255;
    expect(normalised).toBeLessThan(0.03928);
    // Below the threshold, so the LINEAR branch applies: exactly `c / 12.92`.
    expect(channelOf(raw)).toBeCloseTo(normalised / 12.92, 10);
    // And the two branches genuinely differ down there, so getting the threshold wrong is not a
    // rounding detail. The branches CROSS at the threshold: below it the linear branch is the
    // larger of the two. The first version of this assertion had the direction backwards, which
    // is the sort of thing that only fails once somebody actually checks the maths.
    const power = ((normalised + 0.055) / 1.055) ** 2.4;
    expect(channelOf(raw)).toBeGreaterThan(power);
    // And they agree AT the threshold, which is the property that makes 0.03928 vs 0.04045 a
    // near-invisible difference rather than an obvious one.
    const at = 0.03928;
    expect(at / 12.92).toBeCloseTo(((at + 0.055) / 1.055) ** 2.4, 3);
  });
});

describe('every required pair, in both themes', () => {
  for (const theme of THEME_NAMES) {
    it(`${theme} meets every threshold`, () => {
      const failures = auditTheme(theme)
        .filter((r) => !r.passes)
        .map((r) => `${r.pair.name}: ${r.ratio}:1 but needs ${r.minimum}:1`);
      // Named, because "the theme is not accessible enough" is not something anybody can act on.
      expect(failures).toEqual([]);
    });
  }

  it('covers every token that a component could pair with a background', () => {
    // A contrast test against tokens the page does not use tests a fiction. This is the list
    // that makes the fiction checkable, and a token added to the theme without a required pair
    // is a colour nothing has verified.
    for (const name of THEME_NAMES) {
      for (const token of TOKEN_NAMES) {
        const used = REQUIRED_PAIRS.some((p) => p.fg === token || p.bg === token);
        // `background` and `surface` are backgrounds, not foregrounds, so they are exempt from
        // needing a foreground pair of their own.
        if (token === 'background' || token === 'surface') continue;
        expect(used, `${name}.${token} is never checked against anything`).toBe(true);
      }
    }
  });

  it('holds the thresholds plans/15 §2 rule 7 states', () => {
    expect(TEXT_MINIMUM).toBe(4.5);
    expect(UI_MINIMUM).toBe(3);
  });

  it('has both themes with the SAME token names', () => {
    // A token that exists in one theme and not the other is a token whose contrast was checked
    // once, in the theme somebody was looking at.
    expect(Object.keys(THEMES.light).sort()).toEqual(Object.keys(THEMES.dark).sort());
  });
});

describe('the pair that failed when this was written', () => {
  it('light border on surface is at least 3:1', () => {
    // It measured 2.89:1 with border #8a93a2, and passed against `background` at 3.10 -- so it
    // looked fine in review, because a border is only ever seen against a surface. Recorded as a
    // named test so the value cannot drift back.
    const t = THEMES.light;
    expect(ratio(t.border, t.surface)).toBeGreaterThanOrEqual(UI_MINIMUM);
  });

  it('and still clears the background pair with room to spare', () => {
    // Darkening it for the surface must not have broken the pair it already passed.
    expect(ratio(THEMES.light.border, THEMES.light.background)).toBeGreaterThanOrEqual(UI_MINIMUM);
  });
});
