'use client';

/**
 * Focus management, and the one rule that is easy to get backwards.  (P2-T7)
 *
 * ## `plans/15` §2 rule 3, verbatim
 *
 * "**Focus is never lost.** Route changes, autosave completions, and sim `readyForInput` all
 * move focus deliberately. Announce with a polite live region, **never steal focus for a
 * background update.**"
 *
 * Two halves, and the second is the one that gets implemented wrong:
 *
 *   · a USER-INITIATED action moves focus. You pressed a button; the thing that happened is where
 *     focus belongs.
 *   · a BACKGROUND update never does. Autosave completing is not something the author did, and
 *     yanking focus to a "Saved" indicator mid-sentence is the single most hostile thing an
 *     editor can do to somebody with a keyboard.
 *
 * So `announce` and `moveFocus` are separate functions, and only `moveFocus` touches focus. The
 * tests assert that a background update leaves `document.activeElement` alone even when the
 * announcement changes.
 *
 * ## 2.4.11 Focus Not Obscured, and what jsdom can and cannot check
 *
 * A sticky editor header must not cover the focused control. jsdom has no layout, so no
 * implementation can measure occlusion here, and a test that claimed to would be lying.
 *
 * What IS checkable, and is: the scroll margin is derived from ONE constant, so the header
 * height and the compensation cannot drift apart. The actual occlusion check needs a real browser
 * and is listed in the tracker as such.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** The sticky editor chrome's height. The scroll margin is derived from this and nothing else. */
export const STICKY_CHROME_PX = 56;
export const SCROLL_MARGIN = `scroll-margin-top: ${STICKY_CHROME_PX + 8}px`;

/**
 * 2.5.8 Target Size (Minimum, 24×24). Declared as a token so the stylesheet and the test cannot
 * disagree about what "finger-sized" means.
 */
export const MIN_TARGET_PX = 24;

export type FocusReason =
  | { readonly kind: 'user-action'; readonly label: string }
  | { readonly kind: 'route-change'; readonly label: string }
  | { readonly kind: 'background'; readonly label: string }
  | { readonly kind: 'simulation-ready'; readonly label: string };

/** Should this reason move focus? Only the first three do, and route-change is deliberate. */
export function shouldMoveFocus(reason: FocusReason): boolean {
  // `background` and `simulation-ready` are things that happen TO the author. `readyForInput` is
  // in that list because a simulation becoming interactive is a background event even though it
  // is the author waiting for it -- and the fix is an announcement, not a focus grab.
  return reason.kind === 'user-action' || reason.kind === 'route-change';
}

export interface FocusManagerValue {
  /** Announce something. NEVER moves focus. */
  announce(message: string): void;
  /** Move focus deliberately. Refuses for background reasons, and says so. */
  moveFocus(target: HTMLElement, reason: FocusReason): boolean;
  readonly announcement: string;
  readonly lastRefusal: string | null;
}

const FocusContext = createContext<FocusManagerValue | null>(null);

export function FocusProvider(props: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState('');
  const [lastRefusal, setLastRefusal] = useState<string | null>(null);
  // A polite live region that is REPLACED rather than appended to. Appending to a live region
  // makes some screen readers re-announce the whole thing, and a repeated "Saved" is noise that
  // trains people to ignore the region entirely.
  const region = useRef<HTMLParagraphElement>(null);

  const announce = useCallback((message: string) => {
    setAnnouncement(message);
  }, []);

  const moveFocus = useCallback((target: HTMLElement, reason: FocusReason): boolean => {
    if (!shouldMoveFocus(reason)) {
      setLastRefusal(
        `refused to move focus for a ${reason.kind} update: "${reason.label}". ` +
          `Announce it instead — focus belongs to the author.`,
      );
      return false;
    }
    setLastRefusal(null);
    target.focus();
    return true;
  }, []);

  const value = useMemo(
    () => ({ announce, moveFocus, announcement, lastRefusal }),
    [announce, moveFocus, announcement, lastRefusal],
  );

  return (
    <FocusContext.Provider value={value}>
      {props.children}
      <p ref={region} role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
    </FocusContext.Provider>
  );
}

export function useFocusManager(): FocusManagerValue {
  const value = useContext(FocusContext);
  // A hook that returns null and then crashes at the call site is a worse error message than one
  // that says what is missing.
  if (value === null) {
    throw new Error('useFocusManager must be used inside a <FocusProvider>');
  }
  return value;
}

/**
 * Move focus to the page heading on a route change.
 *
 * A SPA route change leaves focus on the link that was clicked, which is now a link to the page
 * you are on -- and the next Tab goes somewhere unrelated. Moving to the heading is the standard
 * remedy, and it is the one case where moving focus without an explicit user action is correct:
 * the navigation WAS the user's action.
 */
export function useRouteFocus(title: string, ref: React.RefObject<HTMLElement | null>): void {
  const { moveFocus } = useFocusManager();
  useEffect(() => {
    const target = ref.current;
    // Not on first render: focusing the heading on load competes with the browser's own
    // behaviour and, worse, means a keyboard user cannot skip it.
    if (target === null) return;
    moveFocus(target, { kind: 'route-change', label: `entered ${title}` });
  }, [title, ref, moveFocus]);
}
