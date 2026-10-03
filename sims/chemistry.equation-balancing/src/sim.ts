/**
 * The protocol half.  (P6-T11, gold sim 12)
 *
 * One text box, because the answer is a line of algebra rather than a value in a field. The input is a
 * real text field rather than `type: number` with a hidden answer behind it, and nothing about the
 * correct equation is in the DOM.
 */

import {
  announce,
  type BridgeHandlers,
  connectSim,
  describeControl,
  focusEntryPoint,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import { type BalanceParams, describeEquation, GIVEN } from './model.js';

const SIM_ID = 'chemistry.equation-balancing';
const SIM_VERSION = '1.0.0';

const CAPABILITIES: SimCapabilities = { grading: true };

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');
  const received: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;

  // Declared and never read: the simulation takes no parameters, and the grader's signature still has to
  // take one. An unused binding here is the honest shape of a simulation with nothing to configure.
  void ({} as BalanceParams);
  let written = '';

  const question = document_.createElement('p');
  question.id = 'sim-question';
  question.textContent = `${GIVEN.left}  →  ${GIVEN.right}`;

  const input = document_.createElement('input');
  input.type = 'text';
  input.id = 'sim-equation';
  input.setAttribute('aria-label', 'the balanced equation');
  // A FORMAT example, and deliberately NOT this question's answer. The first version put the balanced
  // equation in the placeholder, which hands the answer over in grey text -- and a student who copies it
  // submits the right answer without having balanced anything, which is worse than no simulation.
  input.placeholder = '2A + B2 -> 2AB';
  input.addEventListener('input', () => {
    written = input.value;
  });

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Check my equation';
  describeControl(submit, 'Check my equation');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(input, submit);

  alternative.id = 'sim-text-alternative';
  alternative.textContent = describeEquation();
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(question, controls, status, alternative);

  let connection: SimConnection | null = null;

  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(written.trim(), {
      confidence: 1,
      explanation: describeEquation(),
    });
    status.textContent = 'Equation submitted';
    announce(status, 'Equation submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => {},
    onCommand: (name) => {
      if (name === 'reset') {
        written = '';
        input.value = '';
        status.textContent = 'Cleared';
        announce(status, 'Cleared.');
      }
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: () => {},
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    getState: () => ({ written }),
  };

  const transport = {
    post: (frame: unknown): void => {
      parent?.postMessage(frame, '*');
    },
    subscribe: (handler: (frame: unknown, source: unknown) => void): (() => void) => {
      const listener = (event: MessageEvent): void => {
        const type = (event.data as { type?: unknown } | null)?.type;
        if (typeof type === 'string') received.push(type);
        handler(event.data, event.source);
      };
      window_.addEventListener('message', listener);
      return () => window_.removeEventListener('message', listener);
    },
  };

  focusEntryPoint(root);
  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['isBalanced', 'signature'],
  });
  return connection;
}
