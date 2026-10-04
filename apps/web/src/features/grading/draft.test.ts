/**
 * The marking draft.  (P9-T2, P9-T3)
 *
 * Two things are being pinned. A band's prefilled comment never replaces words a teacher typed -- that is data loss
 * on the path a keyboard-first marker uses most. And a write to the device is a RESULT: a store that says nothing when
 * storage refuses is a draft feature the teacher trusts and should not.
 */

import { describe, expect, it } from 'vitest';

import {
  DRAFT_KEY_PREFIX,
  type DraftEvent,
  type DraftKey,
  type DraftStorage,
  EMPTY_DRAFT,
  type MarkDraft,
  memoryDraftStore,
  parseStoredDraft,
  reduceDraft,
  type StoredDraft,
  sameDraft,
  storageDraftStore,
  storageKeyFor,
} from './draft';
import type { MarkingBand } from './rubric';

const FULL: MarkingBand = {
  id: 'band-1',
  points: 5,
  descriptor: 'names both forces and the resulting acceleration',
  feedback: 'Both forces are named and linked to the acceleration.',
};
const PART: MarkingBand = {
  id: 'band-2',
  points: 2,
  descriptor: 'names one force',
  feedback: 'One force is named. The second force is not mentioned.',
};
const NONE: MarkingBand = { id: 'band-3', points: 0, descriptor: 'no force named', feedback: '' };

const run = (events: readonly DraftEvent[], from: MarkDraft = EMPTY_DRAFT): MarkDraft =>
  events.reduce(reduceDraft, from);

describe('applying a band', () => {
  it('sets the mark and the band, and prefills an EMPTY comment', () => {
    const draft = run([{ type: 'BAND_APPLIED', band: PART, via: 'CONTROL' }]);
    expect(draft.score).toBe('2');
    expect(draft.bandId).toBe('band-2');
    expect(draft.feedback).toBe('One force is named. The second force is not mentioned.');
    expect(draft.prefill).toEqual({ bandId: 'band-2', text: PART.feedback });
    expect(draft.offered).toBeNull();
  });

  it('replaces an earlier band’s prefill that nobody touched, because nothing of the teacher’s is in it', () => {
    const draft = run([
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
      { type: 'BAND_APPLIED', band: FULL, via: 'CONTROL' },
    ]);
    expect(draft.score).toBe('5');
    expect(draft.feedback).toBe(FULL.feedback);
    expect(draft.prefill?.bandId).toBe('band-1');
    expect(draft.offered).toBeNull();
  });

  it('NEVER replaces a comment the teacher typed: the mark changes, the words stay, the band comment is OFFERED', () => {
    const draft = run([
      { type: 'FEEDBACK_EDITED', text: 'The diagram is labelled but the working stops at step 2.' },
      { type: 'BAND_APPLIED', band: PART, via: 'KEY' },
    ]);
    expect(draft.score).toBe('2');
    expect(draft.bandId).toBe('band-2');
    expect(draft.feedback).toBe('The diagram is labelled but the working stops at step 2.');
    expect(draft.prefill).toBeNull();
    expect(draft.offered).toEqual({ bandId: 'band-2', text: PART.feedback });
  });

  it('NEVER replaces a prefill the teacher has EDITED, even by one character', () => {
    const draft = run([
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
      { type: 'FEEDBACK_EDITED', text: `${PART.feedback} See page 4.` },
      { type: 'BAND_APPLIED', band: FULL, via: 'CONTROL' },
    ]);
    expect(draft.feedback).toBe(`${PART.feedback} See page 4.`);
    expect(draft.offered).toEqual({ bandId: 'band-1', text: FULL.feedback });
  });

  it('treats a prefill edited and then typed BACK as the teacher’s, and does not replace it', () => {
    // The conservative direction. A prefill is replaceable only while it has never been changed.
    const draft = run([
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
      { type: 'FEEDBACK_EDITED', text: `${PART.feedback}!` },
      { type: 'FEEDBACK_EDITED', text: PART.feedback },
      { type: 'BAND_APPLIED', band: FULL, via: 'CONTROL' },
    ]);
    expect(draft.feedback).toBe(PART.feedback);
    expect(draft.offered).toEqual({ bandId: 'band-1', text: FULL.feedback });
  });

  it('treats a comment that is only whitespace as empty', () => {
    const draft = run([
      { type: 'FEEDBACK_EDITED', text: '  \n ' },
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
    ]);
    expect(draft.feedback).toBe(PART.feedback);
  });

  it('prefills NOTHING from a band with no comment, and leaves the teacher’s words alone', () => {
    const draft = run([
      { type: 'FEEDBACK_EDITED', text: 'No force is identified anywhere in the answer.' },
      { type: 'BAND_APPLIED', band: NONE, via: 'CONTROL' },
    ]);
    expect(draft.score).toBe('0');
    expect(draft.feedback).toBe('No force is identified anywhere in the answer.');
    expect(draft.offered).toBeNull();
  });

  it('REMOVES an untouched prefill when the next band has no comment, so a full-marks comment cannot sit on a zero', () => {
    const draft = run([
      { type: 'BAND_APPLIED', band: FULL, via: 'CONTROL' },
      { type: 'BAND_APPLIED', band: NONE, via: 'CONTROL' },
    ]);
    expect(draft.score).toBe('0');
    expect(draft.feedback).toBe('');
    expect(draft.prefill).toBeNull();
  });

  it('does not offer a comment that is already in the field', () => {
    const draft = run([
      { type: 'FEEDBACK_EDITED', text: `Good diagram.\n\n${PART.feedback}` },
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
    ]);
    expect(draft.offered).toBeNull();
  });

  it('withdraws an earlier offer when a band with no comment is applied', () => {
    const draft = run([
      { type: 'FEEDBACK_EDITED', text: 'My own comment.' },
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
      { type: 'BAND_APPLIED', band: NONE, via: 'CONTROL' },
    ]);
    expect(draft.offered).toBeNull();
    expect(draft.feedback).toBe('My own comment.');
  });
});

describe('the offered comment is inserted only by an explicit act, with a way back', () => {
  const offered = run([
    { type: 'FEEDBACK_EDITED', text: 'The diagram is labelled.  ' },
    { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
  ]);

  it('APPEND keeps the teacher’s words first and adds the band comment after a blank line', () => {
    const draft = reduceDraft(offered, { type: 'OFFER_APPENDED' });
    expect(draft.feedback).toBe(`The diagram is labelled.\n\n${PART.feedback}`);
    expect(draft.offered).toBeNull();
    // The result is the teacher's text now, so a later band must not replace it.
    expect(draft.prefill).toBeNull();
  });

  it('REPLACE keeps what was displaced, and RESTORE puts it back exactly', () => {
    const replaced = reduceDraft(offered, { type: 'OFFER_REPLACED' });
    expect(replaced.feedback).toBe(PART.feedback);
    expect(replaced.displaced).toBe('The diagram is labelled.  ');
    const restored = reduceDraft(replaced, { type: 'DISPLACED_RESTORED' });
    expect(restored.feedback).toBe('The diagram is labelled.  ');
    expect(restored.displaced).toBeNull();
    expect(restored.prefill).toBeNull();
  });

  it('DISMISS drops the offer and touches nothing else', () => {
    const draft = reduceDraft(offered, { type: 'OFFER_DISMISSED' });
    expect(draft).toEqual({ ...offered, offered: null });
  });

  it('is a no-op, returning the same draft, when there is nothing offered or displaced', () => {
    expect(reduceDraft(EMPTY_DRAFT, { type: 'OFFER_APPENDED' })).toBe(EMPTY_DRAFT);
    expect(reduceDraft(EMPTY_DRAFT, { type: 'OFFER_REPLACED' })).toBe(EMPTY_DRAFT);
    expect(reduceDraft(EMPTY_DRAFT, { type: 'OFFER_DISMISSED' })).toBe(EMPTY_DRAFT);
    expect(reduceDraft(EMPTY_DRAFT, { type: 'DISPLACED_RESTORED' })).toBe(EMPTY_DRAFT);
  });
});

describe('how the mark was entered', () => {
  it('records a digit-key band as quick-scored, and a control-chosen band as not', () => {
    expect(run([{ type: 'BAND_APPLIED', band: PART, via: 'KEY' }]).quickScored).toBe(true);
    expect(run([{ type: 'BAND_APPLIED', band: PART, via: 'CONTROL' }]).quickScored).toBe(false);
  });

  it('records a digit on a question with no rubric as the mark itself, quick-scored, with no band', () => {
    const draft = run([{ type: 'QUICK_SCORED', points: 3 }]);
    expect(draft.score).toBe('3');
    expect(draft.bandId).toBeNull();
    expect(draft.quickScored).toBe(true);
  });

  it('stops calling it quick-scored once the mark or the comment is edited by hand', () => {
    expect(
      run([
        { type: 'BAND_APPLIED', band: PART, via: 'KEY' },
        { type: 'FEEDBACK_EDITED', text: 'Edited.' },
      ]).quickScored,
    ).toBe(false);
    expect(
      run([
        { type: 'QUICK_SCORED', points: 3 },
        { type: 'SCORE_TYPED', raw: '3.5' },
      ]).quickScored,
    ).toBe(false);
  });

  it('keeps the mark AS TYPED, so a half-typed number is not rewritten under the cursor', () => {
    expect(run([{ type: 'SCORE_TYPED', raw: '2.' }]).score).toBe('2.');
    expect(run([{ type: 'SCORE_TYPED', raw: 'abc' }]).score).toBe('abc');
  });

  it('forgets the band when the mark is typed over, because the mark is no longer the band’s', () => {
    const draft = run([
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
      { type: 'SCORE_TYPED', raw: '3' },
    ]);
    expect(draft.bandId).toBeNull();
    // The comment is untouched by a change of mark.
    expect(draft.feedback).toBe(PART.feedback);
  });

  it('withdraws "accept the automatic mark" when a different mark is entered by any route', () => {
    const accepted = run([{ type: 'ACCEPT_AUTO_TOGGLED' }]);
    expect(accepted.acceptAuto).toBe(true);
    expect(reduceDraft(accepted, { type: 'SCORE_TYPED', raw: '1' }).acceptAuto).toBe(false);
    expect(reduceDraft(accepted, { type: 'QUICK_SCORED', points: 1 }).acceptAuto).toBe(false);
    expect(reduceDraft(accepted, { type: 'BAND_APPLIED', band: PART, via: 'KEY' }).acceptAuto).toBe(
      false,
    );
  });
});

describe('excuse and flag', () => {
  it('toggles each, and toggling twice is where it started', () => {
    expect(run([{ type: 'EXCUSE_TOGGLED' }]).excused).toBe(true);
    expect(run([{ type: 'EXCUSE_TOGGLED' }, { type: 'EXCUSE_TOGGLED' }]).excused).toBe(false);
    expect(run([{ type: 'FLAG_TOGGLED' }]).flagged).toBe(true);
    expect(run([{ type: 'FLAG_TOGGLED' }, { type: 'FLAG_TOGGLED' }]).flagged).toBe(false);
  });

  it('keeps the reason and the mark when an excuse is switched off, so switching it back loses nothing', () => {
    const draft = run([
      { type: 'SCORE_TYPED', raw: '2' },
      { type: 'EXCUSE_TOGGLED' },
      { type: 'EXCUSE_REASON_EDITED', text: 'Fire alarm during this question.' },
      { type: 'EXCUSE_TOGGLED' },
    ]);
    expect(draft.excused).toBe(false);
    expect(draft.excuseReason).toBe('Fire alarm during this question.');
    expect(draft.score).toBe('2');
  });
});

describe('sameDraft', () => {
  it('compares by value, including the nested comments', () => {
    const a = run([
      { type: 'FEEDBACK_EDITED', text: 'Mine.' },
      { type: 'BAND_APPLIED', band: PART, via: 'CONTROL' },
    ]);
    const b = JSON.parse(JSON.stringify(a)) as MarkDraft;
    expect(sameDraft(a, b)).toBe(true);
    expect(sameDraft(a, { ...b, offered: { bandId: 'band-2', text: 'different' } })).toBe(false);
    expect(sameDraft(a, { ...b, feedback: 'Mine' })).toBe(false);
    expect(sameDraft(a, { ...b, flagged: true })).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────── the store ── */

const KEY: DraftKey = { graderId: 'teacher-1', attemptId: 'attempt-9', responseId: 'response-3' };

const stored = (over: Partial<MarkDraft> = {}): StoredDraft => ({
  draft: { ...EMPTY_DRAFT, score: '2', feedback: 'One force is named.', ...over },
  keptAt: 1_800_000_000_000,
  basedOn: 'rev-4',
});

/** A real, working in-memory `Storage`, so the store is exercised against the interface it will meet. */
const workingStorage = (): DraftStorage & { readonly dump: () => Record<string, string> } => {
  const held = new Map<string, string>();
  return {
    getItem: (name) => held.get(name) ?? null,
    setItem: (name, value) => {
      held.set(name, value);
    },
    removeItem: (name) => {
      held.delete(name);
    },
    dump: () => Object.fromEntries(held),
  };
};

describe('the storage key', () => {
  it('names the grader, the attempt and the response, under a versioned prefix', () => {
    expect(storageKeyFor(KEY)).toBe(`${DRAFT_KEY_PREFIX}:teacher-1:attempt-9:response-3`);
  });

  it('gives two teachers on one machine two different drafts for the same response', () => {
    expect(storageKeyFor(KEY)).not.toBe(storageKeyFor({ ...KEY, graderId: 'teacher-2' }));
  });

  it('cannot be made to collide by an id that contains the separator', () => {
    const a = storageKeyFor({ graderId: 'a:b', attemptId: 'c', responseId: 'd' });
    const b = storageKeyFor({ graderId: 'a', attemptId: 'b:c', responseId: 'd' });
    expect(a).not.toBe(b);
  });
});

describe('storageDraftStore', () => {
  it('writes, reads back the same draft, and removes it', () => {
    const storage = workingStorage();
    const store = storageDraftStore(storage);
    expect(store.read(KEY)).toEqual({ kind: 'NONE' });
    expect(store.write(KEY, stored())).toEqual({ ok: true });
    expect(store.read(KEY)).toEqual({ kind: 'FOUND', stored: stored() });
    store.remove(KEY);
    expect(store.read(KEY)).toEqual({ kind: 'NONE' });
    expect(storage.dump()).toEqual({});
  });

  it('REPORTS a write that threw -- a full quota, or storage disabled -- instead of swallowing it', () => {
    const store = storageDraftStore({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    });
    expect(store.write(KEY, stored())).toEqual({ ok: false, reason: 'STORAGE_REFUSED' });
  });

  it('REPORTS a write that did not throw and did not stick, which is what some private windows do', () => {
    const store = storageDraftStore({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    expect(store.write(KEY, stored())).toEqual({ ok: false, reason: 'READ_BACK_DIFFERS' });
  });

  it('reports something that is not a draft as UNREADABLE, never as "no draft"', () => {
    for (const raw of [
      'not json',
      '{}',
      '[]',
      'null',
      JSON.stringify({ draft: { score: 2 }, keptAt: 1, basedOn: 'x' }),
      JSON.stringify({ ...stored(), keptAt: 'yesterday' }),
      JSON.stringify({ ...stored(), draft: { ...stored().draft, feedback: undefined } }),
      JSON.stringify({ ...stored(), draft: { ...stored().draft, prefill: { bandId: 1 } } }),
    ]) {
      const storage = workingStorage();
      storage.setItem(storageKeyFor(KEY), raw);
      expect(storageDraftStore(storage).read(KEY), raw).toEqual({ kind: 'UNREADABLE' });
    }
  });

  it('reports storage that throws on READ as unreadable rather than empty', () => {
    const store = storageDraftStore({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(store.read(KEY)).toEqual({ kind: 'UNREADABLE' });
  });

  it('does not throw when removal is refused', () => {
    const store = storageDraftStore({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(() => {
      store.remove(KEY);
    }).not.toThrow();
  });
});

describe('parseStoredDraft', () => {
  it('round-trips a draft carrying every optional part', () => {
    const full = stored({
      prefill: { bandId: 'band-2', text: 'p' },
      offered: { bandId: 'band-1', text: 'o' },
      displaced: 'd',
      excused: true,
      excuseReason: 'r',
      flagged: true,
      quickScored: true,
    });
    expect(parseStoredDraft(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it('drops fields it does not know rather than carrying them into the draft', () => {
    const parsed = parseStoredDraft({
      ...stored(),
      draft: { ...stored().draft, somethingElse: '<script>' },
    });
    expect(parsed).toEqual(stored());
  });
});

describe('memoryDraftStore', () => {
  it('holds drafts per key and reports what it holds', () => {
    const store = memoryDraftStore();
    store.write(KEY, stored());
    expect(store.read(KEY)).toEqual({ kind: 'FOUND', stored: stored() });
    expect(Object.keys(store.entries())).toEqual([storageKeyFor(KEY)]);
    store.remove(KEY);
    expect(store.read(KEY)).toEqual({ kind: 'NONE' });
  });
});
