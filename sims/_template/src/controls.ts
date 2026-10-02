/**
 * Controls, kept out of the render function.
 *
 * ## WHY CONTROLS ARE SEPARATE AND WHY THEY ARE NOT A FRAMEWORK
 *
 * Every control here has to be keyboard-reachable, labelled for a screen reader and reachable by
 * `focusEntryPoint`. That is four buttons' worth of requirements per control, so it belongs in one
 * place rather than inlined into a render loop. It is NOT a framework: the SDK has zero runtime
 * dependencies, and a simulation that pulled in a renderer would have a bundle budget belonging to
 * somebody else's release cycle.
 */

import { describeControl, focusEntryPoint, type Stepper } from '@orrery/sim-sdk';

export interface ControlCallbacks {
  readonly onParam: (name: string, value: string | number | boolean) => void;
  readonly onAnswer: (answer: unknown) => void;
  readonly onPlayPause: () => void;
  readonly onStep: () => void;
}

/**
 * Build the control row inside `container`.
 *
 * `container` is passed in rather than queried for an id: a sim that renders inside a lesson block has
 * no idea what the host called its wrapper, and a helper that guesses is a helper the sim works
 * around instead of using.
 */
export function mountControls(
  container: HTMLElement,
  callbacks: ControlCallbacks,
  stepper?: Stepper,
): void {
  const play = document.createElement('button');
  play.type = 'button';
  // A glyph with no name is announced as "button". `describeControl` is the smallest possible fix and
  // the most commonly missing one.
  describeControl(play, 'Play', { pressed: false });
  play.addEventListener('click', () => {
    callbacks.onPlayPause();
    play.setAttribute('aria-pressed', String(!stepper?.mayAutoPlay()));
    announceStatus(container, stepper?.mayAutoPlay() === false ? 'Paused' : 'Playing');
  });

  const step = document.createElement('button');
  step.type = 'button';
  describeControl(step, 'Step forward');
  step.addEventListener('click', callbacks.onStep);

  container.append(play, step);
  focusEntryPoint(container);
}

const announceStatus = (container: HTMLElement, message: string): void => {
  const region = container.ownerDocument.createElement('div');
  region.setAttribute('aria-live', 'polite');
  region.className = 'orrery-sim__live';
  region.textContent = message;
  container.append(region);
};
