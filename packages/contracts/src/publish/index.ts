/**
 * `validateForPublish` — the checklist, with fixes.  (P2-T10)
 *
 * ## The requirement, and the thing not to do
 *
 * The packet: "a checklist where each issue is a deep link to the offending block, plus a
 * one-click fix where one exists... **Do not** make it a wall of red. The publish gate is a
 * checkpoint that helps; a gate that blocks without explaining is a gate teachers route
 * around."
 *
 * That is a design constraint, not a tone preference, and it has two mechanical consequences
 * that the tests assert:
 *
 *   1. **Not every issue blocks.** `severity` is `blocker | warning`, and a document whose only
 *      issues are warnings PUBLISHES. If every rule were a blocker, the gate would be a wall of
 *      red by construction and the only rational teacher behaviour would be to stop reading it.
 *
 *   2. **Every blocker is fixable without leaving the screen.** Either it carries a `fix` the UI
 *      can apply, or it carries a `how` string naming exactly what to change. A blocker with
 *      neither is a dead end, and a dead end is where route-around behaviour starts.
 *
 * ## Why a deep link is a `blockId` and not an index
 *
 * `blocks[7]` is a position. Positions move: insert a paragraph above and it now points at
 * something else, silently, for the next three years. Every block has a stable `id`, so the
 * anchor is `blockId` and the editor resolves it to a position at click time. A link that
 * changes meaning is worse than no link, because it looks like it works.
 *
 * `path` is kept alongside for the human — "3rd item in the 2nd list" — but it is presentation
 * and is not what the link resolves.
 *
 * ## The unmigratable version
 *
 * INV-MIGRATE-1: a version whose `schemaVersion` has no path to current is refused, with the
 * reason naming the version it is stuck at and the fact that no step exists. There is no fix
 * button for that one, deliberately — the fix is either a written migration or abandoning the
 * version, and offering a button that guesses between those two would be worse than saying so.
 */

import type { Block, ContentDocument, TextRun } from '../blocks/index.js';
import { type ValidationIssue, validateDocument } from '../blocks/index.js';
import { LATEST_VERSION, migrateBlocks } from '../blocks/migrate.js';
import { canonicalJson } from '../editor/canonical.js';
import { MAX_BLOCKS_BYTES } from '../media/index.js';
import { classifyUrl } from '../render/escape.js';
import { renderMath } from '../render/index.js';

export type Severity = 'blocker' | 'warning';

/** A one-click fix, described rather than performed, so the caller applies it. */
export type Fix =
  | {
      readonly kind: 'setField';
      readonly label: string;
      readonly field: string;
      readonly value: string;
    }
  | { readonly kind: 'migrateSchema'; readonly label: string }
  | { readonly kind: 'removeBlock'; readonly label: string; readonly field?: string };

export interface ChecklistIssue {
  /** Stable, so React keys and de-duplication do not depend on message text. */
  readonly id: string;
  readonly severity: Severity;
  /** What is wrong, in one sentence a teacher can act on. */
  readonly message: string;
  /** Why it matters. Absent on blockers that are self-evident, present on warnings. */
  readonly why: string;
  /** Human location, e.g. `3rd item in "Forces" list`. Presentation only. */
  readonly where: string;
  /** The stable deep link. `null` only when there is no block to point at. */
  readonly blockId: string | null;
  /** Where the editor should place the cursor. Resolved from `blockId` at click time. */
  readonly anchor: { readonly blockIndex: number; readonly nestedIndex: number | null } | null;
  /** Present whenever a fix is genuinely one click. */
  readonly fix: Fix | null;
  /**
   * Present when there is no one-click fix, and REQUIRED for every blocker.
   *
   * The test asserts this: a blocker with neither a `fix` nor a `how` is a dead end, and the
   * packet's done-when is that every failure mode is fixable from the checklist.
   */
  readonly how: string | null;
}

export interface Checklist {
  readonly issues: readonly ChecklistIssue[];
  readonly blockers: readonly ChecklistIssue[];
  readonly warnings: readonly ChecklistIssue[];
  /** False only for a blocker or an unmigratable version. This is what the button checks. */
  readonly publishable: boolean;
  readonly schemaVersion: number;
  /** The refusal reason, when the version cannot be migrated. INV-MIGRATE-1. */
  readonly refused: string | null;
}

/**
 * A monotonic issue id.
 *
 * The counter is NOT part of the identity — it is only there so two issues with the same rule,
 * block and location still get distinct React keys. Using the rule and block alone would make
 * a list of two "unsafe link" warnings in the same block render one of them twice, or neither.
 */
let counter = 0;
function nextId(rule: string, blockId: string | null, field: string): string {
  counter += 1;
  return `${rule}:${blockId ?? 'document'}:${field}:${counter}`;
}

function issue(input: Omit<ChecklistIssue, 'id'> & { rule: string }): ChecklistIssue {
  const { rule, ...rest } = input;
  return { id: nextId(rule, rest.blockId, rest.where), ...rest };
}

/**
 * Locate a block, and its nested item, by stable id.
 *
 * Returns a position as well as the id because the editor needs a cursor and a link needs a
 * target, and computing the id from the position at click time is what keeps the link honest.
 */
export function locateBlock(
  blocks: readonly Block[],
  blockId: string,
): { blockIndex: number; nestedIndex: number | null } | null {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (block.id === blockId) return { blockIndex: i, nestedIndex: null };
    if (block.type === 'list') {
      for (let j = 0; j < block.items.length; j += 1) {
        if (block.items[j]?.id === blockId) return { blockIndex: i, nestedIndex: j };
      }
    }
  }
  return null;
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export interface ValidateInput {
  /** The raw stored value. Parsed here so an unparseable document is a checklist, not a throw. */
  readonly document: unknown;
  readonly schemaVersion: number;
  /**
   * The resource KIND, which the blocks cannot know about themselves.
   *
   * Passed in because a real check needs it: a simulation in `explore` mode is fine in a lesson
   * and wrong in an exam, and there is nowhere inside a block to put that fact.
   */
  readonly kind?: 'LESSON' | 'QUIZ' | 'EXAM';
}

/**
 * The checklist.
 *
 * Takes the RAW stored value rather than a parsed `ContentDocument`, and that is the whole
 * design. An editor that has already parsed successfully cannot be given a checklist about a
 * version that does not parse — which is the unmigratable case, the single most important one,
 * and it is unparseable BY DEFINITION. Parsing first would mean the gate could not report the
 * failure it exists to catch.
 */
export function validateForPublish(input: ValidateInput): Checklist {
  const issues: ChecklistIssue[] = [];

  // ── 1. The migration path. INV-MIGRATE-1. Checked FIRST ──
  //
  // First because if the version cannot be read by the current schema then nothing below it can
  // be evaluated, and reporting a list of downstream nonsense would be noise. One clear
  // refusal beats forty phantom issues.
  if (input.schemaVersion !== LATEST_VERSION) {
    const migrated = migrateBlocks(
      ((input.document as { blocks?: readonly Block[] }).blocks ?? []) as Block[],
      input.schemaVersion,
      LATEST_VERSION,
    );
    if (!migrated.ok) {
      const refusal =
        `This version is saved at schema version ${input.schemaVersion} and there is no ` +
        `migration from there to ${LATEST_VERSION}. It cannot be published, and it cannot be ` +
        `opened for editing either, because the editor reads the current schema. Publish a new ` +
        `version instead, or ask a platform admin to write the missing migration.`;
      return {
        issues: [],
        blockers: [],
        warnings: [],
        publishable: false,
        schemaVersion: input.schemaVersion,
        refused: refusal,
      };
    }
  }

  const parsed = validateDocument(input.document);
  if (!parsed.ok) {
    // Unparseable at the CURRENT version: a real authoring error, and every one of these is
    // fixable by deleting the offending field. `where` comes from the zod path.
    for (const i of parsed.issues) {
      issues.push(
        issue({
          rule: 'schema',
          severity: 'blocker',
          message: i.message,
          why: 'The current schema cannot read this, so it cannot be rendered or published.',
          where: i.path,
          blockId: null,
          anchor: null,
          fix: null,
          how: `Remove the field at ${i.path}, or raise the document's schemaVersion if it is new.`,
        }),
      );
    }
    return finish(issues, input.schemaVersion, null);
  }

  const doc = parsed.document;
  const blocks = doc.blocks;

  // ── 2. The publish-time size cap. NOT an authoring-time cap ──
  //
  // `plans` is explicit that writing is unconstrained and only publishing is gated, and the
  // reason is worth keeping: an author who is 2.1 MB into a lesson and cannot save has lost
  // work, whereas an author who is told at PUBLISH time that it is a collection of lessons has
  // learned something true about their own material. The cap is a statement about the product's
  // shape, not a limit on typing.
  {
    const bytes = canonicalJson(doc).length;
    if (bytes > MAX_BLOCKS_BYTES) {
      issues.push(
        issue({
          rule: 'tooBig',
          severity: 'blocker',
          message: `This resource is ${(bytes / 1_000_000).toFixed(1)} MB, over the ${(MAX_BLOCKS_BYTES / 1_000_000).toFixed(0)} MB limit for one resource.`,
          why: 'A resource over the limit is a collection of resources. Splitting it makes each part findable, and makes a student downloading one lesson download one lesson. You can keep writing — this is only checked when you publish.',
          where: 'the whole resource',
          blockId: null,
          anchor: null,
          fix: null,
          how: 'Split it into several resources and link them, or move the reference material into the simulation catalogue and embed it.',
        }),
      );
    }
  }

  // ── 3. Is there anything in it ──
  if (blocks.length === 0) {
    issues.push(
      issue({
        rule: 'empty',
        severity: 'blocker',
        message: 'This resource has no content.',
        why: 'A published resource with nothing in it is a dead link for a student.',
        where: 'the whole resource',
        blockId: null,
        anchor: null,
        fix: null,
        how: 'Add at least one block.',
      }),
    );
  }

  // ── 4. Per-block checks ──
  //
  // Every check here is REACHABLE: it fires on a document that has already parsed against the
  // current schema. Most of what the schema can express is therefore already enforced, and a
  // checklist that repeated it would be noise. What is left is exactly the class of mistakes a
  // schema cannot express — a value that is well-typed but wrong, a cross-field relationship,
  // and a rendering failure.
  let lastHeading = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    const push = (
      partial: Omit<ChecklistIssue, 'id' | 'blockId' | 'anchor' | 'where' | 'rule'> & {
        rule: string;
        field: string;
      },
    ) => {
      const { rule, field, ...rest } = partial;
      void field;
      issues.push(
        issue({
          rule,
          blockId: block.id,
          anchor: { blockIndex: i, nestedIndex: null },
          where: `the ${ordinal(i + 1)} block (${block.type})`,
          ...rest,
        }),
      );
    };

    // A link the RENDERER will refuse. A warning, and deliberately linked to the renderer's own
    // allowlist rather than to a second list of schemes: a second list is a second thing to
    // forget, and the symptom without this check is a student clicking a link that quietly goes
    // nowhere, discovered in a live lesson.
    for (const [field, run] of linkRuns(block)) {
      const href = run.href;
      if (href === undefined) continue;
      const verdict = classifyUrl(href);
      if (verdict.safe) continue;
      push({
        rule: 'unsafeLink',
        field,
        severity: 'warning',
        message: `This link will not work: ${verdict.reason}.`,
        why: 'Links are restricted to http, https and mailto, because a lesson is rendered from stored content and a `javascript:` URL in one is an attack on whoever opens it. The link renders as inert text rather than going somewhere unexpected.',
        fix: null,
        how: null,
      });
    }

    switch (block.type) {
      case 'heading': {
        const level = block.level;
        if (lastHeading !== 0 && level > lastHeading + 1) {
          // A WARNING, not a blocker. A skipped heading level is untidy for a screen reader
          // but it does not make the resource unpublishable, and making it one would mean a
          // teacher cannot ship a lesson at 18:50 because of a heading.
          push({
            rule: 'headingSkip',
            field: 'level',
            severity: 'warning',
            message: `This is a heading at level ${level}, jumping from level ${lastHeading}.`,
            why: 'Screen readers announce headings by level, and a jump makes the page outline look broken. It is not a WCAG failure — that is about levels being meaningful, not consecutive — so it does not block.',
            fix: {
              kind: 'setField',
              label: `Make it a level ${lastHeading + 1}`,
              field: 'level',
              value: String(lastHeading + 1),
            },
            how: null,
          });
        }
        lastHeading = level;
        break;
      }

      case 'image': {
        if (block.alt.trim() === '' && (block.caption ?? '').trim() === '') {
          // alt="" is a legitimate DECISION for a decorative image and the renderer honours it,
          // so this is not "missing alt text". It is "empty, with nothing else describing it",
          // which is wrong only if the image carries meaning — and that is not knowable from
          // the content. A blocker here would reject every decorative rule.
          push({
            rule: 'imageAlt',
            field: 'alt',
            severity: 'warning',
            message: 'This image has neither alt text nor a caption.',
            why: 'If the image is decorative, leaving this empty is correct and you can ignore it. If it carries meaning, a student using a screen reader gets nothing at all.',
            fix: null,
            how: null,
          });
        }
        break;
      }

      case 'video': {
        const hasCaptions = (block.captions?.length ?? 0) > 0;
        const hasTranscript = (block.transcript ?? '').trim() !== '';
        if (!hasCaptions && !hasTranscript) {
          // A BLOCKER, and the contrast with the image-alt warning is the point. A decorative
          // image is described by the prose around it; a silent video with no transcript has
          // no alternative at all, and it excludes a deaf student rather than degrading their
          // experience. A caption track or a transcript is a real requirement here.
          push({
            rule: 'videoCaptions',
            field: 'captions',
            severity: 'blocker',
            message: 'This video has neither captions nor a transcript.',
            why: 'Audio-only content with no text alternative excludes a deaf student completely. This one blocks publication.',
            fix: null,
            how: 'Upload a caption track in the media library and attach it here, or paste a transcript into the transcript field. Either is enough; both is better.',
          });
        }
        break;
      }

      case 'practiceCheck': {
        // An immediate-feedback check in an EXAM hands over the answer key. A student can read
        // it, submit, read the correction, change their answer and submit again — and with
        // `maxAttempts` unset that is a pass every time. It is the one authoring choice in the
        // whole content model that can turn an exam into a guessing game, and it needs the
        // resource KIND to detect, which is why the kind is an input here.
        //
        // Reachable: `feedbackPolicy` and the resource kind are independent, and nothing else
        // in the system objects to the combination.
        if (input.kind === 'EXAM' && block.feedbackPolicy === 'immediate') {
          push({
            rule: 'examImmediateFeedback',
            field: 'feedbackPolicy',
            severity: 'blocker',
            message: 'An exam question cannot show the answer immediately.',
            why: 'Immediate feedback reveals which choice was right. A student can read it, change their answer and submit again, so the exam measures nothing and the mark is not a mark.',
            fix: {
              kind: 'setField',
              label: 'Hold the feedback back until the attempt ends',
              field: 'feedbackPolicy',
              value: 'afterAttempt',
            },
            how: null,
          });
        }
        break;
      }

      case 'equation': {
        if (block.latex.trim() === '') {
          push({
            rule: 'equationEmpty',
            field: 'latex',
            severity: 'blocker',
            message: 'This equation is empty.',
            why: 'It renders as a blank line in the middle of a paragraph.',
            fix: null,
            how: 'Type the LaTeX, or delete the block.',
          });
          break;
        }
        try {
          renderMath(block.latex, 'block');
        } catch (e) {
          // The strongest blocker in the checklist, because it is the only one that is
          // PROVABLY visible to a student: KaTeX throws, the renderer has nothing to show, and
          // the whole rest of the block fails with it. A schema cannot catch this — the LaTeX
          // is a perfectly good string — and the author cannot catch it either without reading
          // the rendered page.
          push({
            rule: 'equationRenders',
            field: 'latex',
            severity: 'blocker',
            message: `This equation does not render: ${errorText(e)}`,
            why: 'The maths engine rejects this LaTeX, so a student sees an error in the middle of a paragraph rather than the equation. The lesson cannot be published with it.',
            fix: { kind: 'removeBlock', label: 'Remove this equation', field: 'id' },
            how: 'Fix the LaTeX, or remove the block. The error above is what the maths engine said.',
          });
        }
        break;
      }

      case 'embedSimulation': {
        if (input.kind === 'EXAM' && block.mode === 'explore') {
          // Needs the resource KIND, which the block cannot know. An `explore` simulation
          // behaves differently on every load, so a student who reopens an exam question gets a
          // different question than the one they answered — and the mark is then meaningless.
          push({
            rule: 'examExploreSim',
            field: 'mode',
            severity: 'blocker',
            message: 'An exam cannot contain a simulation in explore mode.',
            why: 'Explore mode gives a different result on every load, so a student who reopens the exam gets a different question to the one they answered, and their mark stops meaning anything.',
            fix: {
              kind: 'setField',
              label: 'Switch it to practice mode',
              field: 'mode',
              value: 'practice',
            },
            how: null,
          });
        }
        break;
      }

      case 'code': {
        const lineCount = block.code.split('\n').length;
        const past = (block.highlightLines ?? []).filter((n) => n > lineCount);
        if (past.length > 0) {
          // The line numbers are 1-BASED and bounded at 10,000, but nothing compares them to
          // the code that is actually there, so deleting a line at the bottom leaves highlights
          // pointing past the end — highlighting nothing, silently.
          push({
            rule: 'codeHighlight',
            field: 'highlightLines',
            severity: 'warning',
            message: `Line ${past.join(', ')} ${past.length === 1 ? 'is' : 'are'} past the end of the code.`,
            why: 'A highlight on a line that does not exist highlights nothing, so the highlighting silently stops working and nobody is told why.',
            fix: {
              kind: 'setField',
              label: 'Drop the lines past the end',
              field: 'highlightLines',
              value: '',
            },
            how: null,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return finish(issues, input.schemaVersion, null);
}

/** Every `{ href }` in a block, paired with the field path that names it. */
function linkRuns(block: Block): readonly (readonly [string, TextRun])[] {
  const out: (readonly [string, TextRun])[] = [];
  const scan = (field: string, runs: readonly TextRun[] | undefined) => {
    for (const run of runs ?? []) if (run.href !== undefined) out.push([field, run]);
  };
  switch (block.type) {
    case 'paragraph':
      scan('content', block.content);
      break;
    case 'heading':
      scan('content', block.content);
      break;
    case 'blockquote':
      scan('content', block.content);
      break;
    case 'callout':
      scan('content', block.content);
      break;
    case 'list':
      for (let i = 0; i < block.items.length; i += 1) {
        const item = block.items[i];
        if (item !== undefined) scan(`items[${i}].content`, item.content);
      }
      break;
    default:
      break;
  }
  return out;
}

function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // KaTeX messages are long and multi-line. The first line names the problem; the rest is
  // context, and a checklist row is one sentence.
  return (message.split('\n')[0] ?? message).slice(0, 160);
}

function finish(
  issues: ChecklistIssue[],
  schemaVersion: number,
  refused: string | null,
): Checklist {
  const blockers = issues.filter((i) => i.severity === 'blocker');
  return {
    issues,
    blockers,
    warnings: issues.filter((i) => i.severity === 'warning'),
    publishable: blockers.length === 0 && refused === null,
    schemaVersion,
    refused,
  };
}

export type { ContentDocument, ValidationIssue };
