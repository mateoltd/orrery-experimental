/**
 * `validateForPublish`.  (P2-T10)
 *
 * ## The two tests this file is really about
 *
 * 1. **Not a wall of red.** A document whose only issues are warnings still PUBLISHES, and
 *    there is a test that a realistic good lesson produces a checklist that is either empty or
 *    entirely warnings. If every rule were a blocker, the gate would be a wall by construction
 *    and the only rational teacher behaviour would be to stop reading it — which the packet
 *    names as the thing to avoid.
 *
 * 2. **Every blocker is fixable from the screen.** Asserted as a SWEEP over every rule rather
 *    than per-test: a blocker with neither a `fix` nor a `how` is a dead end, and dead ends are
 *    where route-around behaviour starts. A per-test assertion would pass until somebody adds
 *    one more rule.
 */

import { describe, expect, it } from 'vitest';
import { knownVersions, LATEST_VERSION } from '../blocks/migrate.js';
import { locateBlock, type ValidateInput, validateForPublish } from './index.js';

/**
 * Block ids are UUIDs, and that is not incidental.
 *
 * The schema's own message is "every block needs a stable uuid so diffs and analytics survive
 * versions" — the same requirement the deep links are built on, arrived at from the other
 * direction. An index moves when a paragraph is inserted above it; a UUID does not, and the
 * schema has been refusing id-shaped-anything-else all along.
 */
let n = 0;
function id(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const AUTHOR = '55555555-5555-4555-8555-555555555555';

/**
 * A stored document, with its ENVELOPE.
 *
 * The envelope carries `title` and `authorId`, not just the blocks — and a helper that
 * omitted them produced a checklist of two phantom "expected string" blockers, which is a nice
 * illustration of the rule this module follows: a checklist that reports a problem with the
 * AUTHORING TOOL is worse than no checklist, because the author cannot act on it.
 */
const doc = (blocks: unknown[], schemaVersion = LATEST_VERSION): ValidateInput => ({
  document: { schemaVersion, title: 'Tides', authorId: AUTHOR, blocks },
  schemaVersion,
});

const p = (text: string, blockId = id()) => ({
  type: 'paragraph',
  id: blockId,
  content: [{ text }],
});
const h = (level: number, text: string, blockId = id()) => ({
  type: 'heading',
  id: blockId,
  level,
  content: [{ text }],
});
const eq = (latex: string, blockId = id()) => ({
  type: 'equation',
  id: blockId,
  latex,
  display: 'block' as const,
});
const img = (alt: string, caption?: string, blockId = id()) => ({
  type: 'image',
  id: blockId,
  assetId: '22222222-2222-4222-8222-222222222222',
  alt,
  ...(caption ? { caption } : {}),
});
const vid = (o: Record<string, unknown> = {}, blockId = id()) => ({
  type: 'video',
  id: blockId,
  provider: 'youtube',
  videoId: 'abc123',
  title: 'A talk about tides',
  ...o,
});

// ── The migration gate. INV-MIGRATE-1. ──────────────────────────────────────────

describe('an unmigratable version', () => {
  it('is refused with the reason, and with NO checklist of phantom issues', () => {
    // A version the current schema cannot read is unparseable BY DEFINITION, which is why this
    // function takes the RAW stored value rather than a parsed document: an editor that had
    // already parsed could not be given a checklist about the failure it exists to catch.
    const result = validateForPublish({
      document: { schemaVersion: 0, title: 'Tides', authorId: AUTHOR, blocks: [p('hello')] },
      schemaVersion: 0,
    });
    expect(result.publishable).toBe(false);
    expect(result.refused).toContain('schema version 0');
    expect(result.refused).toContain(String(LATEST_VERSION));
    // "There is no migration from there" is the actionable half; "your version is old" is not.
    expect(result.refused).toContain('no migration');
    // And nothing else is reported, because nothing else can be evaluated. Forty downstream
    // complaints about a document nobody can read is noise on top of the one thing to fix.
    expect(result.issues).toEqual([]);
  });

  it('says what to do, not just what is wrong', () => {
    const result = validateForPublish({
      document: { schemaVersion: 0, blocks: [] },
      schemaVersion: 0,
    });
    expect(result.refused).toContain('Publish a new version instead');
  });

  it('is the ONLY refusal, and every known version is migrated rather than refused', () => {
    // Guards against the opposite failure: a migration path that exists being reported as
    // missing. If that regressed, every stored version would be unpublishable.
    for (const v of knownVersions()) {
      const result = validateForPublish({
        document: { schemaVersion: v, blocks: [p('hi')] },
        schemaVersion: v,
      });
      expect(result.refused, `schemaVersion ${v}`).toBeNull();
    }
  });
});

// ── Not a wall of red ──────────────────────────────────────────────────────────

describe('not a wall of red', () => {
  it('PUBLISHES a document whose only issues are warnings', () => {
    const result = validateForPublish(
      doc([
        h(2, 'Tides'),
        h(4, 'Why the Moon matters'), // a skipped level
        {
          type: 'paragraph',
          id: id(),
          content: [{ text: 'click', href: 'javascript:alert(1)' }, { text: ' this' }],
        },
        img(''),
      ]),
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.blockers).toEqual([]);
    expect(result.publishable, 'warnings must not block').toBe(true);
  });

  it('produces an EMPTY checklist for a lesson that is simply good', () => {
    const result = validateForPublish(
      doc([
        h(1, 'Why the Moon is tidally locked'),
        p('The Moon rotates once per orbit, so the same face always points at us.'),
        eq('T = 2\\pi\\sqrt{a^3/GM}'),
        img('A diagram of the Earth and Moon with a tidal bulge', 'Tidal locking'),
        {
          type: 'table',
          id: id(),
          caption: 'Surface gravity by body',
          header: ['Body', 'm/s²'],
          rows: [
            ['Mercury', '3.7'],
            ['Earth', '9.8'],
          ],
        },
      ]),
    );
    expect(result.issues).toEqual([]);
    expect(result.publishable).toBe(true);
  });

  it('blocks on a small number of things, and each is a real failure', () => {
    // A gate that blocks on twenty things is a gate people disable. This asserts that severity
    // is not arbitrary: a silent video and an unrenderable equation exclude a student, and a
    // heading level does not.
    //
    // Levels cap at 4, so the "skip" here is 1 -> 4 rather than 1 -> 5. The schema already
    // refuses the impossible jump, which is the same reachability discipline the rules follow.
    const result = validateForPublish(doc([h(1, 'Start'), h(4, 'Jump'), vid(), eq('\\frac{1{')]));
    expect(result.blockers.map((b) => b.message)).toEqual([
      expect.stringContaining('neither captions nor a transcript'),
      expect.stringContaining('does not render'),
    ]);
    // The heading skip is present and is a warning, so the same document blocks on exactly two
    // things and mentions a third without refusing to publish over it.
    expect(result.warnings.map((w) => w.severity)).toEqual(['warning']);
    expect(result.publishable).toBe(false);
  });
});

// ── Every failure mode is fixable from the screen ──────────────────────────────

describe('every blocker is fixable without leaving the screen', () => {
  it('no blocker lacks both a fix and a how', () => {
    // A SWEEP, not a per-test assertion. A blocker with neither is a dead end, and a per-test
    // assertion passes right up until somebody adds one more rule.
    const cases: ValidateInput[] = [
      doc([]),
      doc([vid()]),
      doc([eq('\\frac{1}{')]),
      doc([eq('x^')]),
      doc([
        {
          type: 'practiceCheck',
          id: id(),
          feedbackPolicy: 'immediate',
          question: {
            snapshotId: '11111111-1111-4111-8111-111111111111',
            stem: [{ text: 'Which is bigger?' }],
            choices: [[{ text: 'A' }], [{ text: 'B' }]],
            correctChoiceIndex: 0,
          },
        },
      ]),
      doc(
        [
          {
            type: 'embedSimulation',
            id: id(),
            simId: 'orbits',
            simVersion: '1.0.0',
            params: {},
            seedPolicy: 'FIXED',
            mode: 'explore',
          },
        ],
        LATEST_VERSION,
      ),
    ];
    let seen = 0;
    for (const input of cases) {
      for (const blocker of validateForPublish({ ...input, kind: 'EXAM' }).blockers) {
        seen += 1;
        expect(
          blocker.fix !== null || (blocker.how !== null && blocker.how.length > 0),
          `${blocker.id} is a dead end: ${blocker.message}`,
        ).toBe(true);
      }
    }
    expect(seen, 'the sweep must actually produce blockers').toBeGreaterThan(5);
  });

  it('every issue points at a block, so the checklist can link to it', () => {
    // Only a document-level issue may have `blockId: null` — an empty document has no block to
    // point at, and a link to the nearest one would be a lie.
    const result = validateForPublish(doc([p('fine'), eq('\\frac{1{')]));
    for (const issue of result.issues) {
      if (issue.blockId === null) expect(issue.where).toBe('the whole resource');
      else expect(issue.anchor).not.toBeNull();
    }
  });
});

// ── Deep links survive edits ───────────────────────────────────────────────────

describe('deep links', () => {
  it('address a block by stable id, and the id survives inserting content above it', () => {
    // The reason a link is a `blockId` and not `blocks[7]`: a position moves. Insert a
    // paragraph above and an index link now points at something else, silently, for the next
    // three years. A link that changes meaning is worse than no link, because it looks right.
    const e9 = '33333333-3333-4333-8333-333333333333';
    const before = [h(1, 'Tides'), eq('x', e9)];
    const after = [p('new intro'), h(1, 'Tides'), eq('x', e9)];

    expect(locateBlock(before, e9)).toEqual({ blockIndex: 1, nestedIndex: null });
    // Same id, new position — and the ISSUE still carries the id, so the link still resolves.
    expect(locateBlock(after, e9)).toEqual({ blockIndex: 2, nestedIndex: null });

    const checklist = validateForPublish(doc([h(1, 'Tides'), eq('\\frac{1{', e9)]));
    expect(checklist.blockers[0]?.blockId).toBe(e9);
  });

  it('find a nested list item, with the parent block index', () => {
    const li1 = '44444444-4444-4444-8444-444444444441';
    const li2 = '44444444-4444-4444-8444-444444444442';
    const l1 = '44444444-4444-4444-8444-444444444400';
    const blocks = [
      p('a'),
      {
        type: 'list',
        id: l1,
        style: 'unordered',
        items: [
          { id: li1, content: [{ text: 'one' }] },
          { id: li2, content: [{ text: 'two' }] },
        ],
      },
    ];
    expect(locateBlock(blocks, l1)).toEqual({ blockIndex: 1, nestedIndex: null });
    expect(locateBlock(blocks, li2)).toEqual({ blockIndex: 1, nestedIndex: 1 });
    expect(locateBlock(blocks, '44444444-4444-4444-8444-444444444499')).toBeNull();
  });
});

// ── The individual rules ───────────────────────────────────────────────────────

describe('individual rules', () => {
  it('blocks a video with neither captions nor transcript, and says either will do', () => {
    const result = validateForPublish(doc([vid()]));
    const blocker = result.blockers[0];
    expect(blocker?.message).toContain('neither captions nor a transcript');
    // A real alternative, named, rather than "add captions" with no route to it.
    expect(blocker?.how).toContain('transcript');
  });

  it('accepts a video with a transcript alone', () => {
    const result = validateForPublish(doc([vid({ transcript: 'The speaker begins by...' })]));
    expect(result.publishable).toBe(true);
  });

  it('blocks an exam question that reveals the answer immediately', () => {
    // The one authoring choice in the content model that can turn an exam into a guessing game.
    // Reachable: `feedbackPolicy` and the resource kind are independent, and nothing else in
    // the system objects to the combination.
    const q = {
      type: 'practiceCheck',
      id: id(),
      feedbackPolicy: 'immediate' as const,
      question: {
        snapshotId: '11111111-1111-4111-8111-111111111111',
        stem: [{ text: 'Which is bigger?' }],
        choices: [[{ text: 'A' }], [{ text: 'B' }]],
        correctChoiceIndex: 0,
      },
    };
    const inExam = validateForPublish({ ...doc([q]), kind: 'EXAM' });
    expect(inExam.publishable).toBe(false);
    expect(inExam.blockers[0]?.message).toContain('show the answer immediately');
    expect(inExam.blockers[0]?.fix).toEqual({
      kind: 'setField',
      label: 'Hold the feedback back until the attempt ends',
      field: 'feedbackPolicy',
      value: 'afterAttempt',
    });
    // The SAME question in a lesson is the normal case: a student learning needs to know.
    expect(validateForPublish({ ...doc([q]), kind: 'LESSON' }).publishable).toBe(true);
  });

  it('blocks an equation the maths engine rejects, and offers to remove it', () => {
    const result = validateForPublish(doc([eq('\\frac{1}{')]));
    const blocker = result.blockers[0];
    expect(blocker?.message).toContain('does not render');
    // A schema cannot catch this — the LaTeX is a perfectly good string — and neither can the
    // author without reading the rendered page. It is the most provably student-visible blocker
    // in the checklist.
    expect(blocker?.fix).toEqual({
      kind: 'removeBlock',
      label: 'Remove this equation',
      field: 'id',
    });
  });

  it('blocks an explore-mode simulation in an EXAM but not in a LESSON', () => {
    const sim = {
      type: 'embedSimulation',
      id: id(),
      simId: 'orbits',
      simVersion: '1.0.0',
      params: {},
      seedPolicy: 'FIXED',
      mode: 'explore',
    };
    const inExam = validateForPublish({ ...doc([sim]), kind: 'EXAM' });
    expect(inExam.publishable).toBe(false);
    expect(inExam.blockers[0]?.fix).toEqual({
      kind: 'setField',
      label: 'Switch it to practice mode',
      field: 'mode',
      value: 'practice',
    });
    // The same block in a lesson is fine, and the check needs the KIND to know that — which is
    // why the kind is an input rather than something a block can look up.
    expect(validateForPublish({ ...doc([sim]), kind: 'LESSON' }).publishable).toBe(true);
    expect(validateForPublish(doc([sim])).publishable).toBe(true);
  });

  it('warns about a link the renderer will refuse, using the renderer own allowlist', () => {
    // A second list of safe schemes would be a second thing to forget, and the symptom without
    // this check is a student clicking a link that quietly goes nowhere, in a live lesson.
    const result = validateForPublish(
      doc([
        p('ok'),
        { type: 'paragraph', id: id(), content: [{ text: 'bad', href: 'javascript:alert(1)' }] },
        { type: 'paragraph', id: id(), content: [{ text: 'good', href: 'https://example.org' }] },
      ]),
    );
    const warnings = result.warnings.filter((w) => w.message.includes('will not work'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('javascript:');
    // A warning: the link renders as inert text, which is a worse experience but not an
    // exclusion, so it does not stop a teacher publishing at 18:50.
    expect(result.publishable).toBe(true);
  });

  it('warns about highlights pointing past the end of the code', () => {
    const result = validateForPublish(
      doc([
        {
          type: 'code',
          id: id(),
          code: 'line one\nline two',
          language: 'python',
          highlightLines: [2, 99],
        },
      ]),
    );
    const warning = result.warnings.find((w) => w.message.includes('past the end'));
    expect(warning?.message).toContain('99');
    expect(warning?.message).not.toContain('2 ');
  });

  it('offers a one-click fix for a skipped heading level', () => {
    const result = validateForPublish(doc([h(2, 'Tides'), h(4, 'Forces')]));
    const warning = result.warnings.find((w) => w.message.includes('jumping'));
    expect(warning?.fix).toEqual({
      kind: 'setField',
      label: 'Make it a level 3',
      field: 'level',
      value: '3',
    });
  });

  it('treats an empty document as a blocker with no block to link to', () => {
    const result = validateForPublish(doc([]));
    expect(result.publishable).toBe(false);
    expect(result.blockers[0]?.blockId).toBeNull();
    expect(result.blockers[0]?.where).toBe('the whole resource');
    expect(result.blockers[0]?.how).toContain('at least one block');
  });

  it('reports an unparseable document as fixable field-by-field', () => {
    const result = validateForPublish(
      doc([{ type: 'paragraph', id: id(), content: [{ text: 'hi' }], surprise: true }]),
    );
    expect(result.publishable).toBe(false);
    const issue = result.blockers[0];
    expect(issue?.message).toContain('surprise');
    expect(issue?.how).toContain('surprise');
  });
});

describe('the publish-time size cap', () => {
  it('refuses a resource over 2 MB, and says a 3 MB lesson is a collection of lessons', () => {
    // The packet's done-when. Measured with `canonicalJson`, not `JSON.stringify`, because a
    // key-order-dependent measurement would make the cap fire at a different point on a
    // different day.
    const big = {
      schemaVersion: 1,
      title: 'Huge',
      authorId: '55555555-5555-4555-8555-555555555555',
      // 2000 blocks, which is the schema's own maximum, at 1 100 bytes each. The first version
      // used 4000 blocks and the SCHEMA rejected it before the size check ever ran -- so the test
      // was asserting the wrong error and would have kept passing if the cap were deleted.
      blocks: Array.from({ length: 2000 }, (_, i) => ({
        type: 'paragraph',
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        content: [{ text: 'x'.repeat(1100) }],
      })),
    };
    const result = validateForPublish({ document: big, schemaVersion: 1 });
    expect(result.publishable).toBe(false);
    expect(result.blockers[0]?.message).toContain('over the 2 MB limit');
    expect(result.blockers[0]?.why).toContain('collection of resources');
    // And explicitly: writing is not limited, so the message must not sound like a lost draft.
    expect(result.blockers[0]?.why).toContain('only checked when you publish');
  });

  it('leaves a small resource alone', () => {
    const result = validateForPublish(doc([p('A short lesson.')]));
    expect(result.issues).toEqual([]);
  });
});
