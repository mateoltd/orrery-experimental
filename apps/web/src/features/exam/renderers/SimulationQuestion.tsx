'use client';

/**
 * The `simulation` renderer.  (P7-T7)
 *
 * ## THIS IS THE TYPE `plans/15` CALLS THE BIGGEST RISK: "CANVAS IS INVISIBLE TO A SCREEN READER"
 *
 * A simulation can pass every automated check -- it is a real canvas, it has a real accessible name, axe finds
 * nothing -- and be completely unusable. So the two things that make this type work are both invisible to a linter:
 *
 * 1. **THE TEXT ALTERNATIVE IS NOT OPTIONAL AND NOT A SUMMARY.** The contract requires it to state *what the
 *    visualisation shows*, *what the student is asked to do*, and *where the answer is reported*. For a blind
 *    student that text IS the question, so "a simulation of orbital decay" is not an alternative to anything.
 * 2. **FOCUS IS MOVED DELIBERATELY AND ONLY DELIBERATELY.** `plans/15`'s rule is that focus is never lost and every
 *    move is an intentional act. So the sim does NOT take focus on mount -- `focusOnMount: 'PRESERVED'` -- and
 *    control is handed over on an explicit `Enter` and returned on `Escape`.
 *
 * ## WHY `role="application"` IS CORRECT HERE AND A CRIME EVERYWHERE ELSE
 *
 * `role="application"` tells a screen reader to stop interpreting keys and pass them through. On a form or a question
 * list it breaks the very keys the student needs. It is correct on exactly one thing: a self-contained widget that
 * implements its own key handling and needs `Tab` to mean "next control inside me". That is a simulation surface and
 * nothing else. It is also why `Escape` must exist: inside an application region the student otherwise has no way
 * back out.
 */

import type { PublicSimulationSpec } from '@orrery/contracts/question';
import * as React from 'react';
import { SimulationFrame } from '@/features/sim/SimulationFrame';

export interface SimulationProps {
  readonly spec: PublicSimulationSpec;
  readonly prompt: string;
  /** The simulation's own title, from the registry entry rather than the question text. */
  readonly title: string;
  /**
   * THE TEXT ALTERNATIVE. Three parts, and the contract requires all three.
   *
   * `shows` -- what the visualisation depicts. `task` -- what the student is being asked to do. `reportedIn` -- where
   * the answer ends up. A blind student reading only this has to be able to answer the question.
   */
  readonly textAlternative: {
    readonly shows: string;
    readonly task: string;
    readonly reportedIn: string;
  };
  /**
   * Called when the student presses `Enter` on the surface, i.e. asks for control.
   *
   * The renderer does not implement the simulation; this is the boundary. `handledKeys` is the set of keys the
   * embedded sim consumes while it has control, so `Escape` can be intercepted without swallowing keys the sim
   * legitimately uses -- `Escape` is a common sim key (cancel a run, close a dialog), and stealing it unconditionally
   * would make `Enter`-then-`Escape` release control but would also break the sim's own cancel.
   */
  readonly onEngage: () => void;
  readonly onRelease?: () => void;
  /** Keys the embedded sim consumes, so `Escape` is only intercepted when it is not one of them. */
  readonly handledKeys?: readonly string[];
  readonly readyForInput?: string;
  readonly disabled?: boolean;
  /**
   * THE FRAME CONFIG. Absent by default, and absent means the historical behavior: chrome and canvas
   * mount with nothing booted behind them. Present means a real `SimulationFrame` mounts on engage,
   * with its answer/state callbacks wired to whoever supplied them.
   *
   * Optional rather than required because 97 tests construct this component without a sim backend,
   * and a required frame config would make every one of them invent deployment URLs. The runner
   * supplies it from loader-resolved registry data; tests supply nothing.
   */
  readonly frame?: {
    readonly bundleUrl: string;
    readonly simOrigin: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly onAnswer?: (answer: unknown) => void;
    readonly onState?: (state: unknown, checksum: string | null) => void;
    /**
     * Test injection, mirroring `SimulationFrame`'s own `probeFetch`: the reachability probe in
     * jsdom has no network worth probing, so tests stub it. Production never passes this.
     */
    readonly probeFetch?: typeof fetch | null;
  };
}

export function SimulationQuestion({
  spec,
  prompt,
  title,
  textAlternative,
  onEngage,
  onRelease,
  handledKeys = [],
  readyForInput,
  disabled = false,
  frame,
}: SimulationProps) {
  // Whether the student has taken control. The frame mounts ONLY here: mounting it eagerly would
  // download and boot a simulation the student may never touch, and -- worse -- would start its
  // handshake clock before anyone is listening.
  const [engaged, setEngaged] = React.useState(false);
  const regionId = React.useId();
  const surfaceId = `${regionId}-surface`;
  const returnId = `${regionId}-return`;
  const altId = `${regionId}-alt`;
  const statusId = `${regionId}-status`;

  const simHoldsEscape = handledKeys.includes('Escape');

  /**
   * `Tab` is NOT trapped while the sim holds control.
   *
   * A widget that swallows `Tab` to keep focus inside itself is a keyboard trap unless it provides an explicit way
   * out, and WCAG 2.1.2 is unconditional about that. This surface deliberately does not preventDefault on `Tab`: the
   * student can always leave by tabbing, and `Escape` is the *discoverable* route rather than the only route.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;

    if (event.key === 'Enter') {
      // HAND CONTROL OVER. Deliberate, on a key the student pressed, and the region says so.
      // Sets engaged exactly like the click path below: keyboard and pointer engagement must mount
      // the SAME frame, or there are two ways to engage and only one of them boots the simulation.
      event.preventDefault();
      setEngaged(true);
      onEngage();
      return;
    }

    if (event.key === 'Escape' && !simHoldsEscape) {
      // RETURN CONTROL TO THE QUESTION CHROME, and put focus somewhere the student can see.
      event.preventDefault();
      onRelease?.();
      const target = document.getElementById(returnId);
      target?.focus();
      return;
    }

    // Anything else belongs to the simulation, which is why this renderer does not interpret it.
  };

  return (
    <div>
      {/*
        THE APPLICATION REGION, and the accessible name is the sim title PLUS the question text -- the contract's
        `nameFrom`. The title alone says which simulation; the question alone says nothing about what will happen.
      */}
      <div
        role="application"
        aria-label={`${title}. ${prompt}`}
        aria-describedby={altId}
        id={regionId}
      >
        <h3>{title}</h3>
        <p>{prompt}</p>

        {/*
          THE PINNED SIM IDENTITY, rendered from the spec.

          A simulation question pins `id@version` the way any other resource does, and the renderer is the only place
          that pair is visible to a student. That matters concretely when a student reports "it looks wrong": without
          the version, nobody can tell whether they are looking at the simulation the question pinned or one the
          registry has since moved to.
        */}
        <p>
          <small>
            {spec.simId}@{spec.simVersion}
          </small>
        </p>

        {/*
          THE TEXT ALTERNATIVE, RENDERED AS PROSE AND ALWAYS PRESENT.

          It is a `<dl>` because it has three distinct parts that a student may want to re-read individually, and
          because a run of three sentences is much harder to navigate than three labelled ones. It is referenced by
          `aria-describedby` AND visible, because a text alternative hidden from sight is not an alternative for a
          student who can see but cannot use the canvas.
        */}
        <dl id={altId}>
          <dt>What this shows</dt>
          <dd>{textAlternative.shows}</dd>
          <dt>What to do</dt>
          <dd>{textAlternative.task}</dd>
          <dt>Where your answer is reported</dt>
          <dd>{textAlternative.reportedIn}</dd>
        </dl>

        {/*
          THE SURFACE, AS A REAL `<button>`.

          Focusable, labelled, and NOT auto-focused: `focusOnMount: 'PRESERVED'`, so mounting a question never yanks
          focus from wherever the student was. A native button rather than a `div` with `role="button"`, because the
          element is a control that takes activation -- `role="button"` on a `div` re-implements what the platform
          already provides, and gets focus management and `Space` activation subtly wrong in the process.

          The mount point inside is `aria-hidden`: the region's name and the surface's own label already carry
          everything a screen-reader user needs, and an unlabelled canvas announced as "graphic" is noise between
          them.
        */}
        <button
          id={surfaceId}
          type="button"
          disabled={disabled}
          aria-label={`${title} interactive surface. Press Enter to hand control to the simulation, Escape to return to the question.`}
          aria-describedby={altId}
          onKeyDown={onKeyDown}
          onClick={() => {
            setEngaged(true);
            onEngage();
          }}
        >
          <span aria-hidden="true" data-testid="sim-mount">
            {engaged && frame !== undefined ? (
              <SimulationFrame
                simId={spec.simId}
                simVersion={spec.simVersion}
                bundleUrl={frame.bundleUrl}
                simOrigin={frame.simOrigin}
                probeFetch={frame.probeFetch}
                params={frame.params ?? {}}
                mode="graded"
                // FIXED seed keyed by sim id: every student sees the identical variant, which is the
                // fair default. Per-student variance needs the attempt id plumbed through SimulationProps,
                // which does not carry it -- recorded, not guessed at.
                seedPolicy={{ kind: 'FIXED', seed: spec.simId }}
                defaultHeight={420}
                minHeight={240}
                textAlternative={textAlternative.shows}
                title={title}
                onAnswer={frame.onAnswer}
                onState={frame.onState}
              />
            ) : (
              <canvas width={640} height={360} />
            )}
          </span>
        </button>

        {/*
          THE RETURN CONTROL. A visible, focusable route back into the question chrome.

          `Escape` is the route a keyboard user discovers from the surface's own accessible name, but a student who
          engaged by clicking has no keypress to discover it from, and `plans/15`'s rule is that focus must be
          somewhere they can see when control comes back.
        */}
        <button
          id={returnId}
          type="button"
          onClick={() => {
            onRelease?.();
          }}
          disabled={disabled}
        >
          Return to the question
        </button>

        {/*
          THE LIVE REGION IS `polite` AND SAYS ONLY `readyForInput`.

          Never `assertive`: an assertive announcement here would interrupt whatever the student was doing, and this
          region is inside an application area where they may be mid-keystroke. Nothing else is announced through it
          -- not the title, not the parameters, not the answer. `plans/15`'s rule is that the sim announces when it is
          ready for input and moves focus only deliberately.
        */}
        <div role="status" aria-live="polite" aria-atomic="true" id={statusId}>
          {readyForInput ?? ''}
        </div>
      </div>
    </div>
  );
}
