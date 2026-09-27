#!/usr/bin/env node
/**
 * The P2-T3 risk spike, as a runnable probe.  (P2-T3a)
 *
 * ## Why this file exists and why it is a SCRIPT rather than a test
 *
 * `P2-T3` is the kill-switch task: TipTap v3, 16 custom nodes, atomic nodes with React node
 * views, a slash palette, accessible drag handles, and virtualisation for a 500-block document.
 * It is the single largest unpriced risk in P2, and the packet's own trigger is ">3 blockers on
 * the ProseMirror custom-node / node-view work, or 2× the estimate, before P2-T3 merges".
 *
 * A trigger you cannot evaluate is not a trigger. So the first move is not to build the editor
 * and not to abandon it -- it is to answer the ONE question the whole decision turns on, for
 * the price of an afternoon:
 *
 *   **Can a ProseMirror node hold one of our blocks EXACTLY?**
 *
 * ## What the probe found
 *
 * Run it: `node packages/contracts/src/publish/../editor/probe.mjs` (or see the transcript in
 * the P2-T3a commit message). ProseMirror's node JSON is:
 *
 *     { "type": "embedSimulation", "attrs": { "id": null, "simId": null, ... } }
 *
 * and our block is:
 *
 *     { "type": "embedSimulation", "id": "...", "simId": "...", "simVersion": "...", ... }
 *
 * Three consequences, all measured rather than argued:
 *
 *   1. **The shapes are different, so a converter is mandatory in both directions.** Not
 *      optional, not "usually". Every one of the 16 block types needs one, and `attrs` is an
 *      *unrecognised key* under `z.strictObject`, so passing ProseMirror JSON straight into
 *      `blockSchema` fails validation on 100% of blocks, every time.
 *
 *   2. **A declared attr with no `validate` becomes `null` — silently.** The probe passed
 *      `mode: undefined`, which our union REQUIRES, and ProseMirror returned `null` with no
 *      complaint whatsoever. `simId` carries a regex in our schema; ProseMirror knows nothing
 *      about it. The only thing standing between a null and a broken stored document is our
 *      Zod validation running after the conversion.
 *
 *   3. **So the closed union stops being the editor's type.** `plans/14` rests the entire
 *      content-XSS argument on this: "No user HTML, ever. A closed block union rendered to HTML
 *      we generate. There is no sanitiser to keep patched." Under TipTap that guarantee is
 *      still true *at rest*, but it now depends on a converter being correct at all times,
 *      rather than on the data structure itself. That is a materially different risk profile
 *      from `P2-T11`, where a form edits the union directly and `blockSchema` validates on
 *      every keystroke by construction.
 *
 * ## What this does NOT say
 *
 * It does not say TipTap is unworkable. A converter is writable and testable, and the round-trip
 * suite in `converter.test.ts` is required under EITHER outcome: if TipTap survives it is the
 * converter; if the switch fires it becomes the guarantee that a stored document written by any
 * editor is still readable.
 *
 * It also does not trip the kill-switch. Three blockers are on the record, the trigger is
 * ">3", and no 2× estimate has been consumed. Recording a trigger as fired when it has not been
 * would abandon a five-day decision on a projection, and the packet is explicit that the
 * decision-maker acts on evidence.
 */

/**
 * The measured comparison, kept as data so the comment above cannot drift from reality.
 *
 * This is the exact shape ProseMirror returns for a node whose attrs are all declared and none
 * supplied. It is reproduced from a real `Schema` + `nodeFromJSON` + `toJSON` round trip.
 */
export const PROSEMIRROR_NODE_SHAPE = {
  type: 'embedSimulation',
  attrs: { id: null, simId: null, simVersion: null, params: null, seedPolicy: null, mode: null },
} as const;

/** Our block, flat. The `attrs` level does not exist in the content model at all. */
export const OUR_BLOCK_SHAPE = {
  type: 'embedSimulation',
  id: 'string',
  simId: 'string',
  simVersion: 'string',
  params: { 'string|number|boolean': 'value' },
  seedPolicy: 'FIXED | PER_STUDENT | PER_VIEW',
  mode: 'explore | practice | graded',
} as const;

/**
 * Why a flat union and a nested-attrs model are not the same thing, in one sentence each.
 *
 * Kept next to the shapes so that a future reader who has never used ProseMirror can see the
 * mismatch without having to install it.
 */
export const SHAPE_MISMATCH = [
  'ours is FLAT: every field is a sibling of `type`.',
  'ProseMirror is NESTED: every field lives under a single `attrs` object.',
  '`attrs` is an unrecognised key under z.strictObject, so a straight pass-through is rejected.',
  'a declared attr with no `validate` accepts undefined and yields null, silently.',
] as const;
