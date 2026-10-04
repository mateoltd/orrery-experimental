/**
 * The marking draft: a pure reducer, and the store that keeps it across a closed tab.  (P9-T2, P9-T3)
 *
 * ## A DRAFT IS WRITTEN ON EVERY EDIT, SYNCHRONOUSLY, AND READ BACK
 *
 * `plans/07` §5.1: "Saved drafts; a half-graded submission survives a closed tab." The usual shape of that feature is
 * a debounced autosave, and a debounce is a window in which a closed tab loses what was typed -- the one moment the
 * feature exists for. So there is no debounce here. The draft is small (a mark and a comment), `localStorage` is
 * synchronous, and each edit is written before the next keystroke is handled.
 *
 * It is then READ BACK. A write that did not throw is not a write that happened: private windows, a full quota and
 * storage disabled by policy all fail in ways that differ by browser, and a draft the teacher believes is kept and is
 * not is worse than no draft feature at all, because they stop being careful. `DraftWriteResult` is therefore a
 * result, and the screen says "not kept" in an alert when it is one.
 *
 * ## "KEPT ON THIS DEVICE" IS NOT "SAVED", AND THE TWO NEVER SHARE A WORD
 *
 * A draft is on one browser on one machine. A saved MARK is acknowledged by the server and is what release reads. A
 * status line that said "Saved" for both would have a teacher close their laptop on thirty unsaved marks. See
 * `copy.ts`: the local state is always "kept on this device", and the word "saved" is reserved for an acknowledged
 * mark.
 *
 * ## PREFILLED FEEDBACK NEVER REPLACES SOMETHING A TEACHER WROTE
 *
 * §5.1: "applying a band sets the score and prefills editable feedback." Prefill into an EMPTY field is help. Prefill
 * over a comment the teacher typed is data loss that looks like help, and it happens on exactly the path a
 * keyboard-first marker uses most: type a comment, then press a digit for the band. So `BAND_APPLIED` replaces the
 * comment only when the field is empty or still holds an earlier band's prefill UNTOUCHED. Otherwise the teacher's
 * words stay, the band's comment is OFFERED, and inserting it is an explicit act with a way back.
 */

import type { Millis } from '@orrery/clock';

import type { MarkingBand } from './rubric';
import { prefillFor } from './rubric';

/** A band's comment and which band it came from. */
export interface BandComment {
  readonly bandId: string;
  readonly text: string;
}

export interface MarkDraft {
  /**
   * THE MARK AS TYPED, not as a number.
   *
   * `2.` on the way to `2.5` is not a number yet, and a draft that stored `2` would rewrite the field under the
   * teacher's cursor. It is parsed once, at save, by `parseMark`.
   */
  readonly score: string;
  /** The band the mark was taken from, or `null` when it was typed. */
  readonly bandId: string | null;
  readonly feedback: string;
  /**
   * The prefill currently standing in `feedback` exactly as inserted, or `null` once the teacher has changed it.
   * This is what makes "untouched prefill" a fact rather than a guess: the comment may be replaced by another band's
   * only while `feedback === prefill.text`.
   */
  readonly prefill: BandComment | null;
  /** A band's comment that was NOT inserted because the teacher had already written something. */
  readonly offered: BandComment | null;
  /** What an explicit replace displaced, kept so it can be put back. */
  readonly displaced: string | null;
  readonly excused: boolean;
  readonly excuseReason: string;
  readonly flagged: boolean;
  /** The automatic mark is accepted as it stands. Only offered where one exists; see `markingState.ts`. */
  readonly acceptAuto: boolean;
  /**
   * The mark was set by a single digit key and nothing was edited by hand afterwards.
   *
   * `plans/07` §3.6 records this (`QuestionResponse.wasQuickScored`) so quick-scored responses can be sampled for
   * moderation. It is a fact about how the mark was entered, and the screen tells the teacher it is being recorded.
   */
  readonly quickScored: boolean;
}

export const EMPTY_DRAFT: MarkDraft = {
  score: '',
  bandId: null,
  feedback: '',
  prefill: null,
  offered: null,
  displaced: null,
  excused: false,
  excuseReason: '',
  flagged: false,
  acceptAuto: false,
  quickScored: false,
};

export type DraftEvent =
  | { readonly type: 'SCORE_TYPED'; readonly raw: string }
  /** `via` is how the band was chosen: a digit key is a quick score, a control is not. */
  | { readonly type: 'BAND_APPLIED'; readonly band: MarkingBand; readonly via: 'KEY' | 'CONTROL' }
  /** A digit key on a question with no rubric: the digit IS the mark. */
  | { readonly type: 'QUICK_SCORED'; readonly points: number }
  | { readonly type: 'FEEDBACK_EDITED'; readonly text: string }
  | { readonly type: 'OFFER_APPENDED' }
  | { readonly type: 'OFFER_REPLACED' }
  | { readonly type: 'OFFER_DISMISSED' }
  | { readonly type: 'DISPLACED_RESTORED' }
  | { readonly type: 'EXCUSE_TOGGLED' }
  | { readonly type: 'EXCUSE_REASON_EDITED'; readonly text: string }
  | { readonly type: 'FLAG_TOGGLED' }
  | { readonly type: 'ACCEPT_AUTO_TOGGLED' };

/** Is the comment field holding a band's prefill exactly as it was inserted? */
const prefillUntouched = (draft: MarkDraft): boolean =>
  draft.prefill !== null && draft.feedback === draft.prefill.text;

const applyBandComment = (draft: MarkDraft, band: MarkingBand): MarkDraft => {
  const text = prefillFor(band);
  if (text === null) {
    // THE BAND HAS NO COMMENT. An earlier band's prefill that nobody touched is REMOVED: left standing it would
    // describe a different band from the one whose mark is now in the field -- a full-marks comment on a zero.
    // It was inserted by this reducer and never edited, so removing it deletes nothing a teacher wrote. Anything
    // the teacher did write stays exactly as it is.
    return prefillUntouched(draft)
      ? { ...draft, feedback: '', prefill: null, offered: null }
      : { ...draft, offered: null };
  }
  const comment: BandComment = { bandId: band.id, text };
  if (draft.feedback.trim() === '' || prefillUntouched(draft)) {
    return { ...draft, feedback: text, prefill: comment, offered: null };
  }
  if (draft.feedback.includes(text)) {
    // Already in the comment -- appended earlier, or typed. Offering it again would invite a duplicate paragraph.
    return { ...draft, offered: null };
  }
  // THE TEACHER'S WORDS STAY. The band's comment is offered, never inserted.
  return { ...draft, offered: comment };
};

/** `(draft, event) => draft`. Total: an event that does not apply returns the draft it was given. */
export const reduceDraft = (draft: MarkDraft, event: DraftEvent): MarkDraft => {
  switch (event.type) {
    case 'SCORE_TYPED':
      // A typed mark is no longer the band's mark, and no longer a quick score. Accepting the automatic mark and
      // typing a different one are contradictory, so typing withdraws the acceptance.
      return {
        ...draft,
        score: event.raw,
        bandId: null,
        quickScored: false,
        acceptAuto: false,
      };

    case 'BAND_APPLIED':
      return {
        ...applyBandComment(draft, event.band),
        score: String(event.band.points),
        bandId: event.band.id,
        quickScored: event.via === 'KEY',
        acceptAuto: false,
      };

    case 'QUICK_SCORED':
      return {
        ...draft,
        score: String(event.points),
        bandId: null,
        quickScored: true,
        acceptAuto: false,
      };

    case 'FEEDBACK_EDITED':
      return {
        ...draft,
        feedback: event.text,
        // Once the text differs from what was inserted it is the teacher's, permanently: typing it back to the
        // original does not make it replaceable again. The conservative direction is the one that never deletes.
        prefill: draft.prefill !== null && event.text === draft.prefill.text ? draft.prefill : null,
        quickScored: false,
      };

    case 'OFFER_APPENDED': {
      if (draft.offered === null) return draft;
      const kept = draft.feedback.trimEnd();
      return {
        ...draft,
        feedback: kept === '' ? draft.offered.text : `${kept}\n\n${draft.offered.text}`,
        prefill: null,
        offered: null,
        quickScored: false,
      };
    }

    case 'OFFER_REPLACED':
      if (draft.offered === null) return draft;
      return {
        ...draft,
        // What was there is KEPT, so replacing is an act with a way back rather than a deletion.
        displaced: draft.feedback,
        feedback: draft.offered.text,
        prefill: draft.offered,
        offered: null,
        quickScored: false,
      };

    case 'OFFER_DISMISSED':
      return draft.offered === null ? draft : { ...draft, offered: null };

    case 'DISPLACED_RESTORED':
      if (draft.displaced === null) return draft;
      return { ...draft, feedback: draft.displaced, displaced: null, prefill: null };

    case 'EXCUSE_TOGGLED':
      // The reason is kept when the excuse is switched off, so switching it back on does not ask for it again.
      return { ...draft, excused: !draft.excused };

    case 'EXCUSE_REASON_EDITED':
      return { ...draft, excuseReason: event.text };

    case 'FLAG_TOGGLED':
      return { ...draft, flagged: !draft.flagged };

    case 'ACCEPT_AUTO_TOGGLED':
      return { ...draft, acceptAuto: !draft.acceptAuto };

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

/** Field-by-field, because a draft read back out of storage is a different object from the one it is compared to. */
export const sameDraft = (a: MarkDraft, b: MarkDraft): boolean =>
  a.score === b.score &&
  a.bandId === b.bandId &&
  a.feedback === b.feedback &&
  a.prefill?.bandId === b.prefill?.bandId &&
  a.prefill?.text === b.prefill?.text &&
  a.offered?.bandId === b.offered?.bandId &&
  a.offered?.text === b.offered?.text &&
  a.displaced === b.displaced &&
  a.excused === b.excused &&
  a.excuseReason === b.excuseReason &&
  a.flagged === b.flagged &&
  a.acceptAuto === b.acceptAuto &&
  a.quickScored === b.quickScored;

/* ─────────────────────────────────────────────────────────── the store ── */

export interface DraftKey {
  /**
   * WHOSE draft. A staff-room machine is shared, and a draft keyed only by response would show one teacher another's
   * half-written comment as though it were their own.
   */
  readonly graderId: string;
  readonly attemptId: string;
  readonly responseId: string;
}

export interface StoredDraft {
  readonly draft: MarkDraft;
  readonly keptAt: Millis;
  /**
   * The version of the response this draft was written against. Compared at restore, so a draft written before
   * someone else marked the response is shown as such instead of being presented as current.
   */
  readonly basedOn: string;
}

export type DraftRead =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'FOUND'; readonly stored: StoredDraft }
  /** Something is stored under the key and it is not a draft this build can read. Reported, never treated as NONE. */
  | { readonly kind: 'UNREADABLE' };

export type DraftWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'STORAGE_REFUSED' | 'READ_BACK_DIFFERS' };

export interface DraftStore {
  read(key: DraftKey): DraftRead;
  write(key: DraftKey, stored: StoredDraft): DraftWriteResult;
  remove(key: DraftKey): void;
}

/** Versioned, so a later shape can refuse an earlier one instead of misreading it. */
export const DRAFT_KEY_PREFIX = 'orrery.grading.draft.v1';

export const storageKeyFor = (key: DraftKey): string =>
  // `encodeURIComponent` so an id containing the separator cannot make two different keys collide.
  [DRAFT_KEY_PREFIX, key.graderId, key.attemptId, key.responseId]
    .map((part) => encodeURIComponent(part))
    .join(':');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readComment = (value: unknown): BandComment | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return typeof value.bandId === 'string' && typeof value.text === 'string'
    ? { bandId: value.bandId, text: value.text }
    : undefined;
};

/**
 * A STORED DRAFT, OR `null` IF IT IS NOT ONE.
 *
 * What comes out of `localStorage` was written by some build of this page, possibly an older one, possibly edited by
 * hand in devtools. It has never been near TypeScript, so every field is checked rather than cast -- a draft whose
 * `feedback` is `undefined` would otherwise reach a controlled `<textarea>` and throw on the first render.
 */
export const parseStoredDraft = (value: unknown): StoredDraft | null => {
  if (!isRecord(value) || !isRecord(value.draft)) return null;
  const draft = value.draft;
  const prefill = readComment(draft.prefill);
  const offered = readComment(draft.offered);
  if (
    typeof value.keptAt !== 'number' ||
    !Number.isFinite(value.keptAt) ||
    typeof value.basedOn !== 'string' ||
    typeof draft.score !== 'string' ||
    !(draft.bandId === null || typeof draft.bandId === 'string') ||
    typeof draft.feedback !== 'string' ||
    prefill === undefined ||
    offered === undefined ||
    !(draft.displaced === null || typeof draft.displaced === 'string') ||
    typeof draft.excused !== 'boolean' ||
    typeof draft.excuseReason !== 'string' ||
    typeof draft.flagged !== 'boolean' ||
    typeof draft.acceptAuto !== 'boolean' ||
    typeof draft.quickScored !== 'boolean'
  ) {
    return null;
  }
  return {
    keptAt: value.keptAt,
    basedOn: value.basedOn,
    draft: {
      score: draft.score,
      bandId: draft.bandId,
      feedback: draft.feedback,
      prefill,
      offered,
      displaced: draft.displaced,
      excused: draft.excused,
      excuseReason: draft.excuseReason,
      flagged: draft.flagged,
      acceptAuto: draft.acceptAuto,
      quickScored: draft.quickScored,
    },
  };
};

/** The three `Storage` methods this needs, so a test can hand in one that refuses. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * THE DRAFT STORE OVER `localStorage`.
 *
 * `localStorage` and not IndexedDB, for one reason: it is synchronous. An IndexedDB write is a transaction that
 * commits some time after the call returns, and a tab closed in between loses the edit with no error anywhere.
 *
 * The cost is stated rather than hidden: a draft comment about a named student's work sits unencrypted in this
 * browser profile until the mark is saved or the draft is discarded. It is keyed by grader, removed on save, and
 * the screen says where it is kept.
 */
export const storageDraftStore = (storage: DraftStorage): DraftStore => ({
  read(key) {
    let raw: string | null;
    try {
      raw = storage.getItem(storageKeyFor(key));
    } catch {
      // Storage that cannot be read cannot be said to hold nothing.
      return { kind: 'UNREADABLE' };
    }
    if (raw === null) return { kind: 'NONE' };
    try {
      const stored = parseStoredDraft(JSON.parse(raw));
      return stored === null ? { kind: 'UNREADABLE' } : { kind: 'FOUND', stored };
    } catch {
      return { kind: 'UNREADABLE' };
    }
  },

  write(key, stored) {
    const name = storageKeyFor(key);
    const serialised = JSON.stringify(stored);
    try {
      storage.setItem(name, serialised);
      // READ BACK. Some browsers accept `setItem` in a private window and keep nothing.
      return storage.getItem(name) === serialised
        ? { ok: true }
        : { ok: false, reason: 'READ_BACK_DIFFERS' };
    } catch {
      return { ok: false, reason: 'STORAGE_REFUSED' };
    }
  },

  remove(key) {
    try {
      storage.removeItem(storageKeyFor(key));
    } catch {
      // Nothing to report: a draft that could not be removed is re-offered at the next open, where the teacher
      // can discard it. That is a nuisance, and it is the safe direction.
    }
  },
});

/** A store with no device behind it. For tests, and for a caller that supplies server-side drafts instead. */
export const memoryDraftStore = (
  initial: Readonly<Record<string, StoredDraft>> = {},
): DraftStore & { readonly entries: () => Readonly<Record<string, StoredDraft>> } => {
  const held = new Map<string, StoredDraft>(Object.entries(initial));
  return {
    read: (key) => {
      const stored = held.get(storageKeyFor(key));
      return stored === undefined ? { kind: 'NONE' } : { kind: 'FOUND', stored };
    },
    write: (key, stored) => {
      held.set(storageKeyFor(key), stored);
      return { ok: true };
    },
    remove: (key) => {
      held.delete(storageKeyFor(key));
    },
    entries: () => Object.fromEntries(held),
  };
};

/* ────────────────────────────────────────────────────────── the status ── */

/**
 * WHAT THE TEACHER IS TOLD ABOUT THEIR WORK ON THIS RESPONSE.
 *
 * `KEPT` and `SAVED` are different states with different words (`copy.ts`). There is no state that means "probably
 * fine": every write to the device and every save to the server ends in one of these, including the refusals.
 */
export type DraftStatus =
  /** Nothing has been entered that is not already the saved mark. */
  | { readonly kind: 'NOTHING_TO_KEEP' }
  | { readonly kind: 'KEPT'; readonly at: Millis }
  /** The device refused the write. The draft exists only in this tab. */
  | { readonly kind: 'NOT_KEPT' }
  /** Found on the device when the response was opened. `stale` when it was written against an earlier version. */
  | { readonly kind: 'RESTORED'; readonly at: Millis; readonly stale: boolean }
  | { readonly kind: 'UNREADABLE' }
  | { readonly kind: 'SAVING' }
  /** The server acknowledged the mark. */
  | { readonly kind: 'SAVED'; readonly at: Millis }
  /** `kept` says whether the draft is still on the device, which is the only thing that matters after a failure. */
  | { readonly kind: 'SAVE_FAILED'; readonly reason: string; readonly kept: boolean };
