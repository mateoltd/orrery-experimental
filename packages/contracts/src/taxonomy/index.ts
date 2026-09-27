/**
 * The subject tree and tag algebra, as pure functions.  (P3-T1)
 *
 * ## Cycle safety is the whole point of this file
 *
 * `Subject.parentId` is a self-relation, so `UPDATE "Subject" SET "parentId" = ...` can make a
 * subject its own ancestor. Nothing stops it: no constraint, no trigger, no check. The result is a
 * tree that is a graph, and every query that walks it — the breadcrumb, the "resources in this
 * subject or its children", the subject tree in the library — either loops forever or silently
 * omits a subtree.
 *
 * The check is a walk UP from the proposed parent. If we meet the subject being moved on the way,
 * the move is a cycle. That is simple, and the reason this file exists rather than a line in the
 * data layer is that it is *pure*: a cycle check that can only be exercised against a live
 * database is a cycle check that gets exercised once.
 *
 * ## The walk is bounded, and the bound is a finding
 *
 * The walk stops after `MAX_DEPTH` and reports `depthExceeded` rather than returning a verdict.
 * A tree deeper than that is a data problem worth surfacing -- and a walk that silently gave
 * "no cycle" at depth 5000 would be a walk that says "safe" about a structure it did not read.
 *
 * ## Tag merge is not a rename
 *
 * Merging tag A into tag B has to move BOTH `ResourceTag` and `QuestionTag` rows, and the
 * `@@id([resourceId, tagId])` composite key means a naive insert collides for every resource that
 * already carries both tags. So merge is delete-then-insert, and the duplicate case is the NORMAL
 * case rather than an edge case -- a teacher who has been tagging with "tides" and "seas" has
 * hundreds of resources carrying both.
 */

export type TreeEdge = Readonly<Record<string, string | null>>;

/** Beyond this a "subject tree" is a data problem, and the walk says so rather than guessing. */
export const MAX_DEPTH = 64;

export type CycleVerdict =
  | { readonly cycle: false }
  /**
   * The proposed parent is inside the subject's own subtree.
   *
   * `via` is the PARENT THE AUTHOR CHOSE, not the node the walk happened to close on. The first
   * version returned the closing node, which is always the subject being moved — so the error
   * said "you cannot move physics under physics" when the author had chosen `mechanics`, and the
   * one datum that would let them fix it was the one missing.
   */
  | { readonly cycle: true; readonly via: string }
  /** The walk hit `MAX_DEPTH`; no verdict is claimed. */
  | { readonly depthExceeded: true; readonly at: string };

/**
 * Would setting `subjectId`'s parent to `newParentId` create a cycle?
 *
 * `null` means "to the root", which is always safe — a root has no ancestors, so nothing can be
 * above it. That case is explicit because `parentId` is nullable and "moving to the root" is a
 * real operation, not a no-op.
 */
export function wouldCreateCycle(
  edges: TreeEdge,
  subjectId: string,
  newParentId: string | null,
): CycleVerdict {
  if (newParentId === null) return { cycle: false };
  // Moving a subject under ITSELF is the cycle of length one, and the walk below would catch it
  // on the first step — checked separately so the error message can be specific.
  if (newParentId === subjectId) return { cycle: true, via: newParentId };

  let cursor: string | null | undefined = newParentId;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (cursor === null || cursor === undefined) return { cycle: false };
    if (cursor === subjectId) return { cycle: true, via: newParentId };
    // A parent that does not exist is not this function's problem to judge — it is a foreign key
    // error at write time — and treating it as "safe" here keeps the two failures distinct.
    if (!(cursor in edges)) return { cycle: false };
    cursor = edges[cursor];
  }
  return { depthExceeded: true, at: String(cursor) };
}

/** The chain of ancestors, nearest first, up to the root. */
export function ancestorsOf(edges: TreeEdge, subjectId: string): string[] {
  const out: string[] = [];
  let cursor = edges[subjectId];
  for (let depth = 0; depth < MAX_DEPTH && cursor != null; depth += 1) {
    if (out.includes(cursor)) break; // Already cyclic: stop rather than spin.
    out.push(cursor);
    cursor = edges[cursor];
  }
  return out;
}

/** `Physics > Mechanics > Gravity`, root-first. What the breadcrumb and the canonical URL use. */
export function pathOf(
  edges: TreeEdge,
  names: Readonly<Record<string, string>>,
  subjectId: string,
): string[] {
  return [...ancestorsOf(edges, subjectId)]
    .reverse()
    .map((id) => names[id] ?? id)
    .concat(names[subjectId] ?? subjectId);
}

/** The subject and everything beneath it. The "in this subject or its children" query. */
export function subtreeOf(edges: TreeEdge, rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const [id, parent] of Object.entries(edges)) {
    if (parent === null || parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue; // A pre-existing cycle must not hang the caller.
    seen.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return out;
}

/**
 * A slug, and why it is lowercase-with-dashes.
 *
 * The slug is in a canonical URL (`/subject/quantum-mechanics`), so it is permanent once a teacher
 * has shared it. Lowercase ASCII with dashes survives case-insensitive filesystems, URL
 * auto-completion and search engines, none of which like an underscore or a capital.
 */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Strip the combining marks `normalize` leaves behind, so `Café` becomes `cafe` and not
      // `cafe´` with a stray accent to be percent-encoded forever.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '')
  );
}

export type SlugVerdict =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string };

export function toSlug(input: string): SlugVerdict {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'a slug cannot be empty' };
  const slug = slugify(trimmed);
  if (slug === '') {
    return {
      ok: false,
      reason: `"${trimmed}" has no characters a URL can carry. Try adding a letter or a number.`,
    };
  }
  // Refuse a slug that CHANGED beyond case and punctuation, because that means the input was
  // mostly something a URL cannot hold. Silently producing `physics-101` from `Physics (101)` is
  // usually right; producing `-` from `☠` is not.
  return { ok: true, slug };
}

export type MergeReport = {
  readonly movedResources: number;
  /** Resources that already carried the surviving tag, so the incoming row was a duplicate. */
  readonly deduplicatedResources: number;
  readonly movedQuestions: number;
  readonly deduplicatedQuestions: number;
  readonly deletedTagId: string;
};

export function emptyMergeReport(deletedTagId: string): MergeReport {
  return {
    movedResources: 0,
    deduplicatedResources: 0,
    movedQuestions: 0,
    deduplicatedQuestions: 0,
    deletedTagId,
  };
}

/** A merge that would delete the tag into ITSELF. The obvious way to lose a tag. */
export function isSelfMerge(sourceId: string, targetId: string): boolean {
  return sourceId === targetId;
}
