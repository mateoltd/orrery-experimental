/**
 * The accessibility baseline every sim inherits.  (P6-T3)
 *
 * ## DOM-FREE ON PURPOSE, AND THE TYPES SAY SO
 *
 * This module touches `document`, and it is NOT exported from `./grader` — the DOM-free entry point.
 * `grader-half.test.ts` reads this file's import graph and asserts the grader closure never reaches
 * it, because a metafile assertion catches a bad build and not a bad author.
 *
 * ## EVERY FUNCTION TAKES ITS ELEMENT
 *
 * Nothing here reaches for a global element, a query selector, or an id. A sim that renders a
 * `<canvas>` has no `#root`, and an a11y helper that assumes one is a helper the sim works around
 * rather than uses — so the contract is: pass in the thing you rendered, get back the thing to put
 * in it.
 */

export interface A11yOptions {
  /** Defaults to the live-region politeness the control deserves. */
  readonly politeness?: 'polite' | 'assertive';
  /** Read this text instead of the control's visible label. */
  readonly label?: string;
}

/**
 * Announce to a screen reader through a live region.
 *
 * ## WHY A LIVE REGION AND NOT `aria-label` ON A MOVING TARGET
 *
 * A canvas repaints continuously. Anything that mutates an `aria-label` on a repainting element is
 * announced as though the user pressed something, dozens of times a second, which makes the sim
 * unusable with a screen reader on. So announcements are separate from the drawing, and the caller
 * decides WHEN to say something.
 *
 * ## THE RESET-THEN-SET DELAY IS NOT OPTIONAL
 *
 * Setting the same text twice in a row is not re-announced by most screen readers: the text node did
 * not change, so nothing is spoken. The standard workaround is to clear the region and set it again
 * on the next tick, which is why this takes a `setTimeout` and why `clear()` exists separately.
 */
export function announce(region: HTMLElement, message: string, options: A11yOptions = {}): void {
  if (region.getAttribute('aria-live') === null)
    region.setAttribute('aria-live', options.politeness ?? 'polite');
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

export function clearAnnouncement(region: HTMLElement): void {
  region.textContent = '';
}

/**
 * `true` when the student has asked for less motion.
 *
 * ## THE DEFAULT IS `false`, AND THAT IS DELIBERATE
 *
 * A headless run — a conformance suite, a screenshot, a server-side render — has no media query and
 * must not claim the student asked for reduced motion, because then every automated run pauses and
 * the run measures nothing. The caller passes its own answer when it knows better.
 */
export function prefersReducedMotion(
  win: { readonly matchMedia?: (query: string) => { readonly matches: boolean } } | null = null,
): boolean {
  const view =
    win ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as { matchMedia?: (q: string) => { matches: boolean } }));
  if (view === null || typeof view.matchMedia !== 'function') return false;
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Label a control so its purpose is not its appearance.
 *
 * A play triangle needs `aria-label="Play"`, and the first version shipped the button with a glyph and
 * no name, which a screen reader announces as "button". This is the smallest possible fix and the one
 * most often missing.
 */
export function describeControl(
  element: HTMLElement,
  label: string,
  options: { readonly describedBy?: string; readonly pressed?: boolean } = {},
): HTMLElement {
  element.setAttribute('aria-label', label);
  if (options.describedBy !== undefined)
    element.setAttribute('aria-describedby', options.describedBy);
  if (options.pressed !== undefined) element.setAttribute('aria-pressed', String(options.pressed));
  return element;
}

export interface FocusTrap {
  focusFirst(): void;
  release(): void;
}

/**
 * Keep Tab inside a container, for a modal or for a focused task like a multi-step sequence.
 *
 * ## THE TRAP RESTORES FOCUS ON RELEASE
 *
 * A student who tabs into a sequence, presses Escape and finds themselves at the top of a lesson
 * with no idea how they got there. So the element focused BEFORE the trap is remembered and returned
 * to, which is the single most-missed line in this kind of code.
 *
 * `inert`-free on purpose: `inert` is not in every browser the platform supports, and the trap's job
 * is the TAB ORDER, not the pointer.
 */
export function createFocusTrap(
  container: HTMLElement,
  previous: Element | null = null,
): FocusTrap {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll<HTMLElement>(selector)];
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = container.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeydown);
  return {
    focusFirst(): void {
      const focusable = [...container.querySelectorAll<HTMLElement>(selector)];
      (focusable[0] ?? container).focus();
    },
    release(): void {
      container.removeEventListener('keydown', onKeydown);
      // Focus goes back where it came from. Without this, Escape strands the student at the top of
      // the page and the only way back is reading the whole lesson again.
      if (previous !== null && typeof (previous as HTMLElement).focus === 'function') {
        (previous as HTMLElement).focus();
      }
    },
  };
}

/**
 * Move focus into the sim when the host says the student can act.  (`plans/10` §5.1)
 *
 * The HOST calls this on `sim:readyForInput`, and the sim calls it on whatever it considers its entry
 * point — a canvas, or the first control. It is a function rather than a convention because the whole
 * failure is a student tabbing through an assessment and never arriving at the question.
 */
export function focusEntryPoint(simRoot: HTMLElement, preferred?: HTMLElement | null): void {
  const target =
    preferred ??
    simRoot.querySelector<HTMLElement>('[data-sim-entry]') ??
    simRoot.querySelector<HTMLElement>('canvas, [role="img"], button, [tabindex="0"]') ??
    simRoot;
  if (!target.hasAttribute('tabindex') && target === simRoot) target.setAttribute('tabindex', '-1');
  target.focus();
}

/**
 * Render the text alternative where the sim is not.
 *
 * Called by the host, not the sim: a sim cannot know whether it is blocked by a firewall. Returns the
 * element so the host can place it, and never returns an empty one — a sim that declared no
 * alternative was refused at `defineSim`.
 */
export function textAlternativeElement(text: string, doc: Document): HTMLElement {
  const element = doc.createElement('p');
  element.className = 'sim-text-alternative';
  element.textContent = text;
  return element;
}
