/**
 * The grading key map.  (P9-T2)
 *
 * The bindings are the plan's. What these tests pin is everything around them: that a key a teacher TYPES is never
 * taken for a command, that nothing is bound on a chord the browser owns, and that a held key does not repeat.
 */

import { describe, expect, it } from 'vitest';

import {
  ambiguousBindings,
  boundChords,
  chordOf,
  EQUIVALENT_CONTROL,
  type FocusKind,
  focusKindOf,
  GRADING_KEYMAP,
  type GradingAction,
  KEYS_OFF_ATTRIBUTE,
  type KeyPress,
  RESERVED_CHORDS,
  resolveKey,
} from './keymap';

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  ...over,
});

/** A chord string from the map or the reserved list, turned back into the key press that produces it. */
const pressFor = (chord: string): KeyPress => {
  const parts = chord.split('+');
  const name = parts[parts.length - 1] ?? '';
  const modifiers = new Set(parts.slice(0, -1));
  const key = name === 'Space' ? ' ' : name.length === 1 ? name.toLowerCase() : name;
  return press(key, {
    ctrlKey: modifiers.has('Ctrl'),
    altKey: modifiers.has('Alt'),
    metaKey: modifiers.has('Meta'),
    shiftKey: modifiers.has('Shift'),
  });
};

const ALL_FOCUS: readonly FocusKind[] = ['NONE', 'CONTROL', 'KEYS_OFF', 'TEXT_ENTRY'];

describe('the map itself', () => {
  it('binds exactly the plan’s keys, plus the chorded forms that work inside a field', () => {
    expect(GRADING_KEYMAP.map((binding) => [binding.chord, binding.action, binding.scope])).toEqual(
      [
        ['J', 'response.next', 'OUTSIDE_TEXT_ENTRY'],
        ['K', 'response.previous', 'OUTSIDE_TEXT_ENTRY'],
        ['Alt+J', 'response.next', 'ANYWHERE'],
        ['Alt+K', 'response.previous', 'ANYWHERE'],
        ['0-9', 'mark.digit', 'OUTSIDE_TEXT_ENTRY'],
        ['Enter', 'mark.saveAndNext', 'OUTSIDE_CONTROLS'],
        ['Ctrl+Enter', 'mark.saveAndNext', 'ANYWHERE'],
        ['Meta+Enter', 'mark.saveAndNext', 'ANYWHERE'],
        ['E', 'mark.excuse', 'OUTSIDE_TEXT_ENTRY'],
        ['F', 'mark.flag', 'OUTSIDE_TEXT_ENTRY'],
        ['R', 'feedback.open', 'OUTSIDE_TEXT_ENTRY'],
        ['?', 'help.open', 'OUTSIDE_TEXT_ENTRY'],
      ],
    );
  });

  it('never binds one chord to two actions', () => {
    expect(ambiguousBindings()).toEqual([]);
  });

  it('binds NOTHING on a chord the browser owns', () => {
    const reserved = new Set(RESERVED_CHORDS.map((entry) => entry.chord));
    expect(boundChords().filter((chord) => reserved.has(chord))).toEqual([]);
  });

  it('only lets a binding work inside a text field if it carries a modifier that typing cannot produce', () => {
    // A bare key scoped ANYWHERE would fire on every matching character a teacher types into a comment.
    for (const binding of GRADING_KEYMAP) {
      if (binding.scope !== 'ANYWHERE') continue;
      expect(binding.chord, binding.chord).toMatch(/^(Ctrl|Alt|Meta)\+/);
    }
  });

  it('names a real control for every action, so no action is shortcut-only', () => {
    const actions = new Set<GradingAction>(GRADING_KEYMAP.map((binding) => binding.action));
    for (const action of actions) {
      expect(EQUIVALENT_CONTROL[action], action).toBeTruthy();
    }
    // And no equivalent is declared for an action that has no binding, which would be a stale row.
    expect(Object.keys(EQUIVALENT_CONTROL).sort()).toEqual([...actions].sort());
  });

  it('describes every binding, because the shortcuts list is rendered from this table', () => {
    for (const binding of GRADING_KEYMAP) {
      expect(binding.description.length, binding.chord).toBeGreaterThan(10);
    }
  });
});

describe('resolveKey outside any field', () => {
  it('resolves each of the plan’s bare keys', () => {
    expect(resolveKey(press('j'), 'NONE')).toEqual({ action: 'response.next' });
    expect(resolveKey(press('k'), 'NONE')).toEqual({ action: 'response.previous' });
    expect(resolveKey(press('Enter'), 'NONE')).toEqual({ action: 'mark.saveAndNext' });
    expect(resolveKey(press('e'), 'NONE')).toEqual({ action: 'mark.excuse' });
    expect(resolveKey(press('f'), 'NONE')).toEqual({ action: 'mark.flag' });
    expect(resolveKey(press('r'), 'NONE')).toEqual({ action: 'feedback.open' });
    expect(resolveKey(press('?', { shiftKey: true }), 'NONE')).toEqual({ action: 'help.open' });
  });

  it('resolves every digit to itself, including zero', () => {
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(resolveKey(press(String(digit)), 'NONE')).toEqual({ action: 'mark.digit', digit });
    }
  });

  it('reads a letter the same under Caps Lock and under Shift', () => {
    expect(resolveKey(press('J'), 'NONE')).toEqual({ action: 'response.next' });
    expect(resolveKey(press('J', { shiftKey: true }), 'NONE')).toEqual({
      action: 'response.next',
    });
  });

  it('ignores keys that are not bound', () => {
    for (const key of ['a', 'x', 'ArrowDown', 'PageDown', 'Home', ' ', 'Backspace', 'Delete']) {
      expect(resolveKey(press(key), 'NONE'), key).toBeNull();
    }
  });
});

describe('a key a teacher TYPES is never a command', () => {
  it('resolves NO bare key while focus is in a text field', () => {
    for (const key of ['j', 'k', 'e', 'f', 'r', '?', 'Enter', '0', '1', '5', '9']) {
      expect(resolveKey(press(key), 'TEXT_ENTRY'), key).toBeNull();
    }
  });

  it('resolves NO bare key inside a region that has switched the keys off', () => {
    for (const key of ['j', 'k', 'e', 'f', 'r', '?', 'Enter', '3']) {
      expect(resolveKey(press(key), 'KEYS_OFF'), key).toBeNull();
    }
  });

  it('leaves Enter to a focused control, and still lets letters and digits through there', () => {
    expect(resolveKey(press('Enter'), 'CONTROL')).toBeNull();
    expect(resolveKey(press('j'), 'CONTROL')).toEqual({ action: 'response.next' });
    expect(resolveKey(press('3'), 'CONTROL')).toEqual({ action: 'mark.digit', digit: 3 });
  });

  it('resolves the chorded forms from INSIDE a text field, which is the point of having them', () => {
    expect(resolveKey(press('j', { altKey: true }), 'TEXT_ENTRY')).toEqual({
      action: 'response.next',
    });
    expect(resolveKey(press('k', { altKey: true }), 'TEXT_ENTRY')).toEqual({
      action: 'response.previous',
    });
    expect(resolveKey(press('Enter', { ctrlKey: true }), 'TEXT_ENTRY')).toEqual({
      action: 'mark.saveAndNext',
    });
    expect(resolveKey(press('Enter', { metaKey: true }), 'TEXT_ENTRY')).toEqual({
      action: 'mark.saveAndNext',
    });
  });

  it('reads Alt chords from the PHYSICAL key, because macOS Option+J types a different character', () => {
    expect(resolveKey(press('∆', { altKey: true, code: 'KeyJ' }), 'TEXT_ENTRY')).toEqual({
      action: 'response.next',
    });
    expect(resolveKey(press('˚', { altKey: true, code: 'KeyK' }), 'TEXT_ENTRY')).toEqual({
      action: 'response.previous',
    });
  });

  it('does not take AltGr for Alt: Windows reports AltGr as Ctrl+Alt, and AltGr types characters', () => {
    for (const focus of ALL_FOCUS) {
      expect(resolveKey(press('j', { altKey: true, ctrlKey: true }), focus), focus).toBeNull();
    }
  });

  it('does not treat Shift+Enter as Enter: in a comment it is a line break, and elsewhere it is unbound', () => {
    for (const focus of ALL_FOCUS) {
      expect(resolveKey(press('Enter', { shiftKey: true }), focus), focus).toBeNull();
    }
  });
});

describe('what belongs to the browser stays the browser’s', () => {
  it('ignores every reserved chord, wherever focus is', () => {
    for (const { chord } of RESERVED_CHORDS) {
      for (const focus of ALL_FOCUS) {
        expect(resolveKey(pressFor(chord), focus), `${chord} in ${focus}`).toBeNull();
      }
    }
  });

  it('ignores Ctrl and Meta with every one of the plan’s letters and digits', () => {
    // Ctrl+R is reload, Ctrl+F is find, Ctrl+1 is a tab. A bare-key binding must not also catch its Ctrl form.
    for (const key of ['j', 'k', 'e', 'f', 'r', '0', '1', '9']) {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        expect(
          resolveKey(press(key, modifier), 'NONE'),
          `${JSON.stringify(modifier)}+${key}`,
        ).toBeNull();
      }
    }
  });
});

describe('a held key and a composing key', () => {
  it('ignores auto-repeat for every binding, so a held Enter cannot save its way through an attempt', () => {
    for (const chord of boundChords()) {
      expect(resolveKey({ ...pressFor(chord), repeat: true }, 'NONE'), chord).toBeNull();
    }
  });

  it('ignores a key that is part of an IME composition', () => {
    expect(resolveKey(press('Enter', { isComposing: true }), 'NONE')).toBeNull();
    expect(resolveKey(press('j', { isComposing: true }), 'NONE')).toBeNull();
  });
});

describe('chordOf', () => {
  it('writes modifiers in one fixed order', () => {
    expect(chordOf(press('Enter', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Enter');
    expect(chordOf(press('j', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+J');
    expect(chordOf(press('Tab', { shiftKey: true }))).toBe('Shift+Tab');
    expect(chordOf(press(' '))).toBe('Space');
    expect(chordOf(press('3', { altKey: true }))).toBe('Alt+3');
  });
});

describe('focusKindOf', () => {
  /** Built with the DOM API rather than parsed from a string, so there is no markup-from-text anywhere in this lane. */
  const el = (
    tag: string,
    attributes: Readonly<Record<string, string>> = {},
    inside?: { readonly tag: string; readonly attributes?: Readonly<Record<string, string>> },
  ): Element => {
    const target = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value);
    if (inside !== undefined) {
      const parent = document.createElement(inside.tag);
      for (const [name, value] of Object.entries(inside.attributes ?? {})) {
        parent.setAttribute(name, value);
      }
      parent.append(target);
    }
    return target;
  };

  it('calls anything that takes typing TEXT_ENTRY', () => {
    expect(focusKindOf(el('textarea'))).toBe('TEXT_ENTRY');
    expect(focusKindOf(el('input'))).toBe('TEXT_ENTRY');
    expect(focusKindOf(el('input', { type: 'text' }))).toBe('TEXT_ENTRY');
    expect(focusKindOf(el('input', { type: 'search' }))).toBe('TEXT_ENTRY');
    expect(focusKindOf(el('input', { type: 'number' }))).toBe('TEXT_ENTRY');
    expect(focusKindOf(el('select'))).toBe('TEXT_ENTRY');
    expect(
      focusKindOf(el('span', {}, { tag: 'div', attributes: { contenteditable: 'true' } })),
    ).toBe('TEXT_ENTRY');
  });

  it('treats an input type it has never heard of as text, which is the safe direction', () => {
    expect(focusKindOf(el('input', { type: 'something-new' }))).toBe('TEXT_ENTRY');
  });

  it('calls operated controls CONTROL', () => {
    expect(focusKindOf(el('button'))).toBe('CONTROL');
    expect(focusKindOf(el('input', { type: 'radio' }))).toBe('CONTROL');
    expect(focusKindOf(el('input', { type: 'checkbox' }))).toBe('CONTROL');
    expect(focusKindOf(el('summary', {}, { tag: 'details' }))).toBe('CONTROL');
    expect(focusKindOf(el('a', { href: '#x' }))).toBe('CONTROL');
  });

  it('calls a pane, a heading, or nothing at all NONE', () => {
    expect(focusKindOf(el('section', { tabindex: '0' }))).toBe('NONE');
    expect(focusKindOf(el('h2', { tabindex: '-1' }))).toBe('NONE');
    expect(focusKindOf(null)).toBe('NONE');
  });

  it('calls a button inside a keys-off region KEYS_OFF, and a text field in one still TEXT_ENTRY', () => {
    const off = { tag: 'div', attributes: { [KEYS_OFF_ATTRIBUTE]: 'off' } };
    expect(focusKindOf(el('button', {}, off))).toBe('KEYS_OFF');
    expect(focusKindOf(el('textarea', {}, off))).toBe('TEXT_ENTRY');
  });
});
