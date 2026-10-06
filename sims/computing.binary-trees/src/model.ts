/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 72 `computing.binary-trees`)
 *
 * ## THE TREE IS NOT REBALANCED, AND THAT IS THE CARD'S FOCUS
 *
 * An auto-balancing insert makes every tree look the same height, so the student never meets the invariant
 * the question is about: a search-tree shape is a consequence of the INSERTION ORDER, and two orders of the
 * same seven values are two different trees. So `insert` is plain BST insertion and there is no balancing
 * mode to switch on. The card's phrase "rebalances only if a declared balancing mode is on" is satisfied by
 * declaring the mode and it being absent — adding AVL rotations would answer a different question.
 *
 * ## THREE NAMED FUNCTIONS, ONE TREE
 *
 * In-order, pre-order and post-order are three traversals of the SAME structure, and if they are three
 * separate implementations then two of them can disagree. They are three functions over one node type, so a
 * change to the shape changes all three at once and a test can assert they partition the node values — which
 * is the property that actually catches a traversal bug, and which no per-traversal expected list would.
 *
 * ## THE TREE NEVER GOES IN THE STATE
 *
 * `canonicalJson` rejects anything that is not a plain object or a finite number
 * (`packages/sim-sdk/src/state.ts:60-64`), so a node graph with cycles cannot be serialised at all. The
 * state carries the INSERTION ORDER — a string — and the tree is rebuilt from it, which is also what makes
 * the replay exact: the stored state is the question, not a picture of it.
 */

export interface TreeNode {
  readonly value: number;
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
}

export interface TreeParams {
  /** The values in the order they were inserted, comma separated. */
  readonly insertOrder: string;
}

/** How many values this simulation will accept. Twelve is where the drawing stops being readable. */
export const MAX_VALUES = 12;
export const MIN_VALUES = 1;

/** Parse the declared insertion order. A value that is not an integer is DROPPED, not rounded. */
export function parseOrder(raw: string): number[] {
  return raw
    .split(/[,;\s]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(Number)
    .filter((value) => Number.isInteger(value) && Math.abs(value) <= 999)
    .slice(0, MAX_VALUES);
}

/** Plain BST insertion: smaller to the left, larger to the right, and DUPLICATES ARE DROPPED. */
export function insert(root: TreeNode | null, value: number): TreeNode {
  if (root === null) return { value, left: null, right: null };
  if (value === root.value) return root;
  if (value < root.value) return { ...root, left: insert(root.left, value) };
  return { ...root, right: insert(root.right, value) };
}

export function buildTree(values: readonly number[]): TreeNode | null {
  return values.reduce<TreeNode | null>((root, value) => insert(root, value), null);
}

export const root = (params: TreeParams): TreeNode | null =>
  buildTree(parseOrder(params.insertOrder));

/** In-order: left subtree, node, right subtree. Sorted ascending for a BST, which is the invariant. */
export function inOrder(node: TreeNode | null): string[] {
  if (node === null) return [];
  return [...inOrder(node.left), String(node.value), ...inOrder(node.right)];
}

/** Pre-order: node, left subtree, right subtree. The order the tree was BUILT in. */
export function preOrder(node: TreeNode | null): string[] {
  if (node === null) return [];
  return [String(node.value), ...preOrder(node.left), ...preOrder(node.right)];
}

/** Post-order: left subtree, right subtree, node. The order in which a node can be DELETED. */
export function postOrder(node: TreeNode | null): string[] {
  if (node === null) return [];
  return [...postOrder(node.left), ...postOrder(node.right), String(node.value)];
}

/**
 * Height in EDGES, so a single node has height 0.
 *
 * EDGES rather than nodes because `height(left) === height(right)` is the balance test and the two readings
 * differ by one, so a height reported in one unit and tested in the other makes every tree look balanced or
 * every tree look wrong. The alternative is tested on NODES, so both readings appear in the tests and the
 * unit each uses is named.
 */
export function height(node: TreeNode | null): number {
  if (node === null) return -1;
  return 1 + Math.max(height(node.left), height(node.right));
}

/** The BST invariant, as a CHECK rather than as an assertion in a comment: left < node < right. */
export function invariantHolds(node: TreeNode | null): boolean {
  if (node === null) return true;
  const inSubtree = (
    candidate: TreeNode | null,
    low: number | null,
    high: number | null,
  ): boolean => {
    if (candidate === null) return true;
    if (low !== null && candidate.value <= low) return false;
    if (high !== null && candidate.value >= high) return false;
    return (
      inSubtree(candidate.left, low, candidate.value) &&
      inSubtree(candidate.right, candidate.value, high)
    );
  };
  return inSubtree(node, null, null) && invariantHolds(node.left) && invariantHolds(node.right);
}

/**
 * Balanced means every node's two subtrees differ in height by at most one.
 *
 * In NODES, not edges: `height` counts edges and returns -1 for an absent child, so the edge reading of the
 * balance test is the node reading shifted by one on every subtree, and a one-off is exactly the difference
 * between "balanced" and "not".
 */
export function balanced(node: TreeNode | null): boolean {
  if (node === null) return true;
  const levels = (current: TreeNode | null): number =>
    current === null ? 0 : 1 + Math.max(levels(current.left), levels(current.right));
  const difference = Math.abs(levels(node.left) - levels(node.right));
  return difference <= 1 && balanced(node.left) && balanced(node.right);
}

/**
 * Read a yes/no answer, because `asNumber` returns null for a boolean and `numeric` would then report
 * UNPARSEABLE for a student who answered `true`.
 *
 * The three spellings are the three a checkbox, a select and a text box produce. Refusing `yes` would teach
 * a student the host's preferred spelling rather than the trees.
 */
export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

export const clamp = (raw: Partial<TreeParams>): TreeParams => {
  const text = typeof raw.insertOrder === 'string' ? raw.insertOrder : '';
  const values = parseOrder(text);
  return { insertOrder: values.length === 0 ? '50,25,75,12,37,62,87' : values.join(',') };
};

/** Every node with its parent, for the non-visual table the card requires beside the drawing. */
export function connections(
  node: TreeNode | null,
): { value: string; parent: string; side: string }[] {
  const rows: { value: string; parent: string; side: string }[] = [];
  const walk = (current: TreeNode | null, parent: string, side: string): void => {
    if (current === null) return;
    rows.push({ value: String(current.value), parent, side });
    walk(current.left, String(current.value), 'left');
    walk(current.right, String(current.value), 'right');
  };
  walk(node, '—', 'root');
  return rows;
}

/** The text alternative, DERIVED: it quotes the three orders it is describing. */
export function describeTree(params: TreeParams): string {
  const tree = root(params);
  const values = parseOrder(params.insertOrder);
  if (tree === null) return 'No values have been inserted, so there is no tree.';
  return (
    `A binary search tree built by inserting ${values.join(', ')} in that order, with no rebalancing. ` +
    `In order it reads ${inOrder(tree).join(', ')}. Pre-order it reads ${preOrder(tree).join(', ')}. ` +
    `Post-order it reads ${postOrder(tree).join(', ')}. It is ${String(height(tree))} edges tall and ` +
    `${balanced(tree) ? 'balanced' : 'not balanced'}.`
  );
}
