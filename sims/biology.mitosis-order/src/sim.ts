/**
 * The protocol half.  (P6-T11, gold sim 11)
 *
 * Reordering is done with UP and DOWN buttons rather than drag-and-drop, because drag is not reachable
 * from a keyboard and this simulation declares `keyboard: true`.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import { describeOrder, move, type OrderParams, STAGES, shuffled } from './model.js';

const SIM_ID = 'biology.mitosis-order';
const SIM_VERSION = '1.0.0';

const CAPABILITIES: SimCapabilities = { grading: true };

const PARAM_SPECS = {
  count: num({ name: 'count', label: 'Stages', unit: '', min: 2, max: 6, default: 6 }),
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const list = document_.createElement('ol');
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');
  const received: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;

  let params: OrderParams = { count: 6 };
  // The shuffle is SEEDED and never random, so the same student gets the same question twice and a test
  // gets the same question every run.
  let order: string[] = shuffled(6, 20_260_926);
  let submitted = false;

  const render = (): void => {
    list.textContent = '';
    order.forEach((name, index) => {
      const stage = STAGES.find((entry) => entry.name === name);
      const item = document_.createElement('li');
      item.id = `sim-stage-${String(index)}`;
      const label = document_.createElement('span');
      label.className = 'stage-detail';
      label.textContent = stage?.detail ?? name;
      const buttons = document_.createElement('span');
      buttons.className = 'stage-buttons';
      const up = document_.createElement('button');
      up.type = 'button';
      up.id = `sim-up-${String(index)}`;
      up.textContent = 'Move up';
      describeControl(up, `Move ${String(index + 1)} up`);
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        order = move(order, index, index - 1);
        render();
        focusEntryPoint(root);
      });
      const down = document_.createElement('button');
      down.type = 'button';
      down.id = `sim-down-${String(index)}`;
      down.textContent = 'Move down';
      describeControl(down, `Move ${String(index + 1)} down`);
      down.disabled = index === order.length - 1;
      down.addEventListener('click', () => {
        order = move(order, index, index + 1);
        render();
        focusEntryPoint(root);
      });
      buttons.append(up, down);
      item.append(label, buttons);
      list.append(item);
    });
  };

  alternative.id = 'sim-text-alternative';
  alternative.textContent = describeOrder(params.count);
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit order';
  describeControl(submit, 'Submit order');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(submit);
  root.append(list, controls, status, alternative);

  let connection: SimConnection | null = null;

  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(order, {
      confidence: 1,
      explanation: describeOrder(params.count),
    });
    submitted = true;
    status.textContent = 'Order submitted';
    announce(status, 'Order submitted.');
  });

  const applyParams = (next: Partial<OrderParams>): void => {
    params = { ...params, ...next };
    order = shuffled(params.count, 20_260_926);
    submitted = false;
    alternative.textContent = describeOrder(params.count);
    render();
  };

  const handlers: BridgeHandlers = {
    onResize: () => render(),
    onCommand: (name) => {
      if (name === 'reset') applyParams({ count: 6 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ count: Number(values.count) });
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    getState: () => ({ order, count: params.count, submitted }),
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

  render();
  focusEntryPoint(root);
  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['move', 'shuffled', 'NAMES'],
  });
  return connection;
}
