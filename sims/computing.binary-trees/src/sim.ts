/**
 * The protocol half.  (P12-T2, card 72 `computing.binary-trees`)
 *
 * ## THE CARD'S MODALITY IS `diagram`, AND IT SAYS WHAT THE NON-VISUAL PATH IS
 *
 * "The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a
 * non-visual student sees the same graph as edges, which is what the grader reads too." So there are two
 * renderings of ONE tree: a nested list, which is real DOM and is readable, and the connections table,
 * which is the same edges in the shape a reader can scan. There is no canvas and no SVG, because neither is
 * reachable by Tab and the card asks for the diagram handle to be a `<button>`.
 *
 * ## EACH NODE IS A TOGGLE BUTTON BECAUSE EXPANDING A SUBTREE IS A REAL STATE
 *
 * `aria-pressed` on a button that means nothing is a lie an assistive technology will faithfully repeat. Here
 * pressing a node collapses or restores its descendants in the nested list, so the pressed state is the
 * truth about what is on screen.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  asBoolean,
  balanced,
  clamp,
  connections,
  describeTree,
  height,
  inOrder,
  postOrder,
  preOrder,
  root,
  type TreeParams,
} from './model.js';

const SIM_ID = 'computing.binary-trees';
const SIM_VERSION = '1.0.0';

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  randomised: false,
  audio: false,
  webgl: false,
  stepper: false,
  scenarios: [],
};

const PARAM_SPECS = {
  insertOrder: {
    type: 'string' as const,
    name: 'insertOrder',
    label: 'Insertion order',
    default: '50,25,75,12,37,62,87',
    maxLength: 120,
  },
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): TreeParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({ insertOrder: String(values.insertOrder) });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root_ = document_.getElementById('sim-root') ?? document_.body;
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => errors.push(String(event.message)));

  let params = paramsFrom({});
  const collapsed = new Set<string>();

  const heading = document_.createElement('h2');
  heading.id = 'sim-question';
  const drawing = document_.createElement('div');
  drawing.id = 'sim-drawing';
  const table = document_.createElement('table');
  table.id = 'sim-connections';
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  root_.append(heading, drawing, table, controls, status, alternative);

  const field = (id: string, labelText: string): HTMLInputElement => {
    const input = document_.createElement('input');
    input.type = 'text';
    input.id = id;
    const label = document_.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const wrapper = document_.createElement('div');
    wrapper.append(label, input);
    return input;
  };

  const inField = field('sim-in-order', 'In-order traversal, node values separated by commas');
  const preField = field('sim-pre-order', 'Pre-order traversal, node values separated by commas');
  const postField = field(
    'sim-post-order',
    'Post-order traversal, node values separated by commas',
  );
  const heightField = field('sim-height', 'Height, as a number of edges');
  const balancedField = field('sim-balanced', 'Is the tree balanced? yes or no');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');

  const reveal = document_.createElement('button');
  reveal.type = 'button';
  reveal.id = 'sim-reveal';
  describeControl(reveal, 'Show the three traversals');

  controls.append(inField, preField, postField, heightField, balancedField, reveal, submit);
  let connection: SimConnection | null = null;

  const nodeButton = (value: string, depth: number): HTMLElement => {
    const button = document_.createElement('button');
    button.type = 'button';
    button.className = 'tree-node';
    button.textContent = value;
    const isCollapsed = collapsed.has(value);
    // THE PRESSED STATE IS A FACT ABOUT THE SCREEN, not decoration: a collapsed node has no descendants in
    // the list below it, and a reader who cannot see them should be told they are folded away.
    describeControl(button, `Node ${value}, ${isCollapsed ? 'collapsed' : 'expanded'}`, {
      pressed: isCollapsed,
    });
    button.addEventListener('click', () => {
      if (collapsed.has(value)) collapsed.delete(value);
      else collapsed.add(value);
      refresh();
      announce(status, `Node ${value} ${collapsed.has(value) ? 'collapsed' : 'expanded'}.`);
    });
    button.dataset.depth = String(depth);
    return button;
  };

  const renderTree = (
    node: ReturnType<typeof root>,
    list: HTMLUListElement,
    depth: number,
  ): void => {
    if (node === null) return;
    const item = document_.createElement('li');
    item.append(nodeButton(String(node.value), depth));
    const value = String(node.value);
    if (!collapsed.has(value) && (node.left !== null || node.right !== null)) {
      const children = document_.createElement('ul');
      renderTree(node.left, children, depth + 1);
      renderTree(node.right, children, depth + 1);
      if (children.childElementCount > 0) item.append(children);
    }
    list.append(item);
  };

  const renderTable = (): void => {
    const rows = connections(root(params));
    table.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent =
      'Every node, its parent and the side it hangs on. This is the same tree as the list above, in the ' +
      'shape a screen reader can scan row by row.';
    table.append(caption);
    const head = document_.createElement('tr');
    for (const [label, scope] of [
      ['Node', 'col'],
      ['Parent', 'col'],
      ['Side', 'col'],
    ] as const) {
      const cell = document_.createElement('th');
      cell.scope = scope;
      cell.textContent = label;
      head.append(cell);
    }
    const thead = document_.createElement('thead');
    const headRow = document_.createElement('tr');
    headRow.append(head);
    thead.append(headRow);
    table.append(thead);
    const tbody = document_.createElement('tbody');
    for (const row of rows) {
      const tr = document_.createElement('tr');
      for (const value of [row.value, row.parent, row.side]) {
        const cell = document_.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  };

  const refresh = (): void => {
    const tree = root(params);
    heading.textContent =
      tree === null ? 'Insert some values to build a tree' : `Tree root ${String(tree.value)}`;
    const list = document_.createElement('ul');
    list.id = 'sim-tree';
    list.setAttribute('aria-label', 'The binary search tree, root first');
    renderTree(tree, list, 0);
    drawing.replaceChildren(list);
    renderTable();
    alternative.textContent = describeTree(params);
  };

  reveal.addEventListener('click', () => {
    const tree = root(params);
    if (tree === null) return;
    inField.value = inOrder(tree).join(', ');
    preField.value = preOrder(tree).join(', ');
    postField.value = postOrder(tree).join(', ');
    heightField.value = String(height(tree));
    balancedField.value = balanced(tree) ? 'yes' : 'no';
    announce(status, 'The three traversals, the height and the balance claim are filled in.');
  });

  submit.addEventListener('click', () => {
    const list = (field_: HTMLInputElement): string[] =>
      field_.value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    connection?.bridge?.reportAnswer(
      {
        inOrder: list(inField),
        preOrder: list(preField),
        postOrder: list(postField),
        height: Number(heightField.value),
        balanced: asBoolean(balancedField.value),
      },
      { confidence: 1, explanation: describeTree(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: TreeParams): void => {
    params = next;
    collapsed.clear();
    for (const input of [inField, preField, postField, heightField, balancedField])
      input.value = '';
    refresh();
  };

  const handlers: BridgeHandlers = {
    onResize: () => refresh(),
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'focus') focusEntryPoint(root_);
    },
    onSetParams: (next) => restart(paramsFrom(next)),
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    onRestore: (state) => {
      if (state !== null && typeof state === 'object') {
        restart(paramsFrom(state as Record<string, unknown>));
      }
    },
    getState: () => ({ insertOrder: params.insertOrder }),
  };

  const transport = {
    post: (frame: unknown): void => parent?.postMessage(frame, '*'),
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

  refresh();
  focusEntryPoint(root_);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['buildTree', 'inOrder', 'preOrder', 'postOrder', 'height', 'balanced'],
  });

  return connection;
}
