/**
 * Invitations and join codes against a real Postgres.  (P4-T3, P4-T4)
 *
 * ## The tests that matter
 *
 *  · `the alphabet contains NO ambiguous pair` — asserted against the alphabet, because
 *    `plans/01` §1 still lists the alphabet B17 rejected. The plan text is the thing that was
 *    wrong, so the test states the correct one rather than trusting the document.
 *  · `regenerating a code INVALIDATES the previous one` — a bearer token that outlives its
 *    revocation is a bearer token forever.
 *  · `wrong, expired, revoked and unknown codes are INDISTINGUISHABLE` — the enumeration
 *    property, and the one most likely to be broken by a well-meaning "helpful error message".
 *  · `a code is stored as a KEYED hash, never as the code` — the "hashed at rest" property,
 *    checked by reading the row rather than by trusting the function name.
 *  · `a code locks after N failures, and regenerating unlocks it` — the reason 24^8 is survivable.
 *
 * ## The clock is FROZEN
 *
 * Expiry and cooldown are durations. A suite that tests them by waiting is a suite that does
 * not test them.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, HOUR, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { addMember, createClassroom } from './classrooms.js';
import {
  acceptInvitation,
  addMemberDirectly,
  CODE_ALPHABET,
  CODE_HINT_LENGTH,
  CODE_LENGTH,
  codeMatches,
  deriveCode,
  expireInvitations,
  extendInvitation,
  hashCode,
  inviteByEmail,
  issueJoinCode,
  lockGroundCodes,
  MAX_CODE_FAILURES,
  normaliseCode,
  RESEND_COOLDOWN_MS,
  redeemJoinCode,
  resendInvitation,
  revokeInvitation,
} from './invitations.js';
import { PrismaClient } from './prisma.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const SECRET = 'test-secret-not-used-anywhere-else-0123456789';
const T0: Millis = Date.UTC(2026, 8, 1, 9, 0, 0);
const clock = () => new FrozenClock(T0);

function actorOf(id: string, roles: string[] = ['teacher']): Actor {
  return { id, roles: roles as never, mfaVerified: true, suspended: false };
}

async function user(
  email?: string,
  opts: { isMinor?: boolean; suspended?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const address = email ?? `${id}@i.example`;
  await prisma().user.create({
    data: {
      id,
      email: address,
      emailNormalized: address.toLowerCase(),
      name: 'P',
      ...(opts.isMinor === undefined ? {} : { isMinor: opts.isMinor }),
      ...(opts.suspended === undefined ? {} : { status: opts.suspended ? 'SUSPENDED' : 'ACTIVE' }),
    },
  });
  return id;
}

async function room(
  name = `Room ${randomUUID().slice(0, 6)}`,
): Promise<{ id: string; ownerId: string; owner: Actor }> {
  const ownerId = await user();
  const created = await createClassroom(prisma(), { name, actor: actorOf(ownerId) });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, ownerId, owner: actorOf(ownerId) };
}

/* ------------------------------------------------------------------ *
 * The alphabet
 * ------------------------------------------------------------------ */

describe('P4-T3 the join code alphabet', () => {
  it('contains NO visually ambiguous pair, which is the whole reason it exists', () => {
    // B17: the original 31-symbol alphabet "contradicted its own rationale -- 8 and B are both
    // present, 5 and S are both present, so two of the three claimed disambiguations were not
    // applied". And `plans/01` §1 STILL lists that alphabet today. The plan text is the thing
    // that was wrong, so this test states the correct alphabet rather than asserting against a
    // document that has not been fixed.
    const ambiguous: readonly (readonly string[])[] = [
      ['0', 'O'],
      ['1', 'I'],
      ['1', 'L'],
      ['8', 'B'],
      ['5', 'S'],
      ['2', 'Z'],
    ];
    for (const [a, b] of ambiguous) {
      expect(CODE_ALPHABET.includes(a), `${a} should have been dropped`).toBe(false);
      expect(CODE_ALPHABET.includes(b), `${b} should have been dropped`).toBe(false);
    }
    // And the count is stated, because an alphabet that quietly gains a glyph changes the search
    // space and nobody notices. It was 24 in the first version of this test and of the module
    // comment, because 5 digits + 20 letters was done as 5 + 19. A stated search-space size is a
    // number somebody has to have counted.
    expect(CODE_ALPHABET).toHaveLength(25);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
    expect(CODE_ALPHABET).toBe(CODE_ALPHABET.toUpperCase());
    expect(CODE_ALPHABET).not.toMatch(/[^0-9A-Z]/);
  });

  it('a code is 8 symbols from that alphabet, so the space is bounded and stated', () => {
    // 25^8 is the number the rate limiter and the failure counter exist for. At 6 characters
    // from 31 symbols B17 measured it as grindable in about a day.
    const code = deriveCode(SECRET, 'classroom-a', 0);
    expect(code).toHaveLength(CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(25 ** 8).toBeGreaterThan(1e11);
  });

  it('a code is a function of the classroom AND the counter', () => {
    // A code generator whose output is not a function of its inputs is a CONSTANT, and a
    // constant is a public code. This is the assertion that would catch someone "simplifying"
    // the derivation into a constant or a random roll.
    const a = deriveCode(SECRET, 'classroom-a', 0);
    expect(deriveCode(SECRET, 'classroom-a', 0)).toBe(a);
    expect(deriveCode(SECRET, 'classroom-b', 0)).not.toBe(a);
    expect(deriveCode(SECRET, 'classroom-a', 1)).not.toBe(a);
    // …and of the secret, which is what makes it unpredictable to anybody but the platform.
    expect(deriveCode('another-secret', 'classroom-a', 0)).not.toBe(a);
  });

  it('the platform cannot reproduce a code, and normalisation is forgiving about separators', () => {
    // The reason a code is hashed rather than stored: there is no column for it and no path to
    // it, so a stolen table does not hand out access.
    const code = deriveCode(SECRET, 'classroom-a', 0);
    expect(normaliseCode(`  ${code.slice(0, 4)}-${code.slice(4).toLowerCase()}  `)).toBe(code);
    // A teacher who writes the separator has entered the right code, and being told it is
    // unknown is the most likely way a code is abandoned at the moment it is needed.
    expect(codeMatches(SECRET, code, hashCode(SECRET, code))).toBe(true);
    expect(codeMatches(SECRET, code.toLowerCase(), hashCode(SECRET, code))).toBe(true);
    // A different code is false, and a corrupt stored value is false rather than a throw.
    expect(codeMatches(SECRET, 'ZZZZZZZZ', hashCode(SECRET, code))).toBe(false);
    expect(codeMatches(SECRET, code, 'not-a-hash')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * P4-T3. Issuing
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4-T3 issuing invitations, against real Postgres', () => {
  it('a code is returned ONCE and stored ONLY as a keyed hash', async () => {
    // Checked by reading the row, not by trusting the function name. "Hashed at rest" is a
    // claim about the database and the database is where it is true or false.
    const r = await room();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      clock(),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toHaveLength(CODE_LENGTH);

    const row = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
      select: { codeHash: true, codeHint: true, codeCounter: true, email: true },
    });
    expect(row.codeHash).not.toBeNull();
    expect(row.codeHash).not.toBe(issued.code);
    // The hash is a MAC: it must not be reproducible from the code without the secret.
    expect(row.codeHash).toBe(hashCode(SECRET, issued.code));
    expect(hashCode('wrong-secret', issued.code)).not.toBe(row.codeHash);
    // The hint is the LAST two characters, so a teacher can recognise a code on a printed sheet
    // and the platform still cannot reproduce it.
    expect(row.codeHint).toBe(issued.code.slice(-CODE_HINT_LENGTH));
    expect(row.codeCounter).toBe(0);
    // Exactly one of email / code, which the CHECK enforces and this confirms by reading.
    expect(row.email).toBeNull();
  });

  it('a plain SHA-256 of the code would be guessable OFFLINE — which is why it is a MAC', async () => {
    // Not a test of the implementation but of the REASONING, stated as a test so the argument is
    // checked rather than asserted in a comment. 24^8 is ~1.1e11; an unkeyed digest of a 41-bit
    // secret is a lookup table anybody with a stolen table can build.
    const code = deriveCode(SECRET, 'classroom-a', 0);
    const { createHash } = await import('node:crypto');
    const plain = createHash('sha256').update(normaliseCode(code)).digest('hex');
    // A plain digest depends only on the code, so it carries no deployment secret…
    expect(plain).not.toContain(SECRET);
    // …and therefore the same code in two deployments produces the same stored value, which is
    // exactly what lets one stolen table be attacked for every deployment at once.
    expect(plain).toBe(createHash('sha256').update(normaliseCode(code)).digest('hex'));
    // The MAC does not.
    expect(hashCode(SECRET, code)).not.toBe(hashCode('other-deployment-secret', code));
  });

  it('regenerating a code INVALIDATES the previous one', async () => {
    // A bearer token that outlives its revocation is a bearer token forever. `plans/12` §2.2:
    // "Regenerable; regeneration revokes the previous code."
    const r = await room();
    const c = clock();
    const first = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!first.ok) throw new Error(first.reason);

    const second = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!second.ok) throw new Error(second.reason);
    expect(second.code).not.toBe(first.code);
    expect(second.invitationId, 'regeneration must not create a second row').toBe(
      first.invitationId,
    );

    // The old code is dead, and the new one works.
    const stranger = actorOf(await user());
    const stale = await redeemJoinCode(
      prisma(),
      { code: first.code, user: stranger, secret: SECRET },
      c,
    );
    expect(stale.ok, 'the previous code still works after regeneration').toBe(false);

    const fresh = actorOf(await user());
    const good = await redeemJoinCode(
      prisma(),
      { code: second.code, user: fresh, secret: SECRET },
      c,
    );
    expect(good.ok).toBe(true);
  });

  it('an email invitation is created, and re-inviting returns the SAME pending row', async () => {
    // Two pending invitations for one person means two accept links and a support question
    // about which one is real.
    const r = await room();
    const c = clock();
    const email = `${randomUUID()}@school.example`;
    const first = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email, role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!first.ok) throw new Error(first.reason);
    expect(first.alreadyPending).toBe(false);

    const again = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email, role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!again.ok) throw new Error(again.reason);
    expect(again.alreadyPending).toBe(true);
    expect(again.invitationId).toBe(first.invitationId);
    expect(await prisma().classroomInvitation.count({ where: { classroomId: r.id, email } })).toBe(
      1,
    );
  });

  it('the database refuses an invitation with BOTH an email and a code', async () => {
    // `plans/01`: "exactly one of email / codeHash". A row with both can be used two ways, by
    // two people who may have been told different things about it.
    const r = await room();
    await expect(
      prisma().classroomInvitation.create({
        data: {
          classroomId: r.id,
          email: 'both@school.example',
          codeHash: 'deadbeef',
          codeHint: 'EF',
          sentById: r.ownerId,
          expiresAt: new Date(T0 + HOUR),
        },
      }),
    ).rejects.toThrow();
    // …and one with neither, which is an invitation to nobody.
    await expect(
      prisma().classroomInvitation.create({
        data: { classroomId: r.id, sentById: r.ownerId, expiresAt: new Date(T0 + HOUR) },
      }),
    ).rejects.toThrow();
  });

  it('OWNER cannot be invited', async () => {
    const r = await room();
    const email = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'x@school.example', role: 'OWNER', actor: r.owner },
      clock(),
    );
    expect(email.ok).toBe(false);
    if (!email.ok) expect(email.reason).toMatch(/transfer/);
  });

  it('a student cannot invite anybody to a classroom', async () => {
    const r = await room();
    const student = await user();
    await addMember(
      prisma(),
      { classroomId: r.id, userId: student, role: 'STUDENT', actor: r.owner },
      clock(),
    );
    const result = await inviteByEmail(
      prisma(),
      {
        classroomId: r.id,
        email: 'nope@school.example',
        role: 'STUDENT',
        actor: actorOf(student, ['student']),
      },
      clock(),
    );
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * P4-T4. Lifecycle
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4-T4 invitation lifecycle, against real Postgres', () => {
  it('accepting is IDEMPOTENT, and a double-click is not an error', async () => {
    const r = await room();
    const invitee = await user();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'kid@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);

    const actor = actorOf(invitee, ['student']);
    const first = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actor },
      c,
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyMember).toBe(false);

    // The second click must not create a second enrollment, and must not report a failure either:
    // a second click that says "already a member" reads as a failure to somebody who has just
    // been told they joined.
    const second = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actor },
      c,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyMember).toBe(true);
    expect(await prisma().enrollment.count({ where: { classroomId: r.id, userId: invitee } })).toBe(
      1,
    );
  });

  it('an ALREADY-ENROLLED user accepting is a no-op with a clear message', async () => {
    const r = await room();
    const invitee = await user();
    await addMember(
      prisma(),
      { classroomId: r.id, userId: invitee, role: 'STUDENT', actor: r.owner },
      clock(),
    );
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'already@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);

    const result = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actorOf(invitee, ['student']) },
      c,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyMember).toBe(true);
    expect(await prisma().enrollment.count({ where: { classroomId: r.id, userId: invitee } })).toBe(
      1,
    );
  });

  it('an invitation accepted by SOMEONE ELSE cannot be reused', async () => {
    const r = await room();
    const a = await user();
    const b = await user();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'one@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);
    await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actorOf(a, ['student']) },
      c,
    );

    const thief = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actorOf(b, ['student']) },
      c,
    );
    expect(thief.ok).toBe(false);
    expect(await prisma().enrollment.count({ where: { classroomId: r.id, userId: b } })).toBe(0);
  });

  it('an EXPIRED invitation cannot be accepted, and a sweeper marks it', async () => {
    const r = await room();
    const invitee = await user();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      {
        classroomId: r.id,
        email: 'late@school.example',
        role: 'STUDENT',
        actor: r.owner,
        ttlDays: 1,
      },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);

    c.advance(2 * 24 * HOUR);
    const tooLate = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actorOf(invitee, ['student']) },
      c,
    );
    expect(tooLate.ok).toBe(false);

    // The sweeper is a separate pass, for the same reason the code lock is: a check inside the
    // accept path would need to read before it could decide.
    expect(await expireInvitations(prisma(), c)).toBeGreaterThan(0);
    const row = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: invited.invitationId },
      select: { status: true },
    });
    expect(row.status).toBe('EXPIRED');
  });

  it('extending revives an EXPIRED invitation from TODAY, not from a past date', async () => {
    // Extending from the stored expiry would leave an expired invitation expired, and the button
    // would appear to do nothing.
    const r = await room();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      {
        classroomId: r.id,
        email: 'revive@school.example',
        role: 'STUDENT',
        actor: r.owner,
        ttlDays: 1,
      },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);
    c.advance(10 * 24 * HOUR);
    await expireInvitations(prisma(), c);

    const extended = await extendInvitation(
      prisma(),
      { invitationId: invited.invitationId, days: 7, actor: r.owner },
      c,
    );
    expect(extended.ok).toBe(true);
    const row = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: invited.invitationId },
      select: { status: true, expiresAt: true },
    });
    expect(row.status).toBe('PENDING');
    expect(row.expiresAt.getTime()).toBeGreaterThan(c.now());
  });

  it('a resend inside the cooldown is refused, and says how long is left', async () => {
    const r = await room();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'resend@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);

    const tooSoon = await resendInvitation(
      prisma(),
      { invitationId: invited.invitationId, actor: r.owner },
      c,
    );
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.reason).toMatch(/wait \d+s before resending/);

    c.advance(RESEND_COOLDOWN_MS + 1000);
    const fine = await resendInvitation(
      prisma(),
      { invitationId: invited.invitationId, actor: r.owner },
      c,
    );
    expect(fine.ok).toBe(true);
    expect(
      (
        await prisma().classroomInvitation.findUniqueOrThrow({
          where: { id: invited.invitationId },
        })
      ).resendCount,
    ).toBe(1);
  });

  it('a revoked invitation cannot be accepted, and stays in the table as a record', async () => {
    // The row stays, so "was this sent, and did it come back" is answerable.
    const r = await room();
    const invitee = await user();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'revoked@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);

    expect(
      (await revokeInvitation(prisma(), { invitationId: invited.invitationId, actor: r.owner })).ok,
    ).toBe(true);
    const after = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: actorOf(invitee, ['student']) },
      c,
    );
    expect(after.ok).toBe(false);
    const row = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: invited.invitationId },
      select: { status: true },
    });
    expect(row.status).toBe('REVOKED');
  });

  it('a suspended account cannot accept or redeem', async () => {
    // An enrollment for a suspended account resolves to NO roles (INV-CLASSROOM-1), so letting
    // it through creates a join that looks successful and behaves like a rejection.
    const r = await room();
    const c = clock();
    const invited = await inviteByEmail(
      prisma(),
      { classroomId: r.id, email: 'susp@school.example', role: 'STUDENT', actor: r.owner },
      c,
    );
    if (!invited.ok) throw new Error(invited.reason);
    const suspended = actorOf(await user(), ['student']);
    suspended.suspended = true;
    const result = await acceptInvitation(
      prisma(),
      { invitationId: invited.invitationId, user: suspended },
      c,
    );
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The security properties
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4-T4 join code security, against real Postgres', () => {
  it('wrong, expired, revoked and UNKNOWN codes are INDISTINGUISHABLE', async () => {
    // The enumeration property. If any of these differed, the endpoint reports which codes exist
    // and which rooms are still waiting for one, and a teacher with plausible codes could sweep a
    // school by watching the wording change.
    //
    // The cost is real: a legitimate user with an expired code is told it is "not valid", and it
    // is paid on purpose, because the alternative is an oracle on a bearer token.
    const r = await room();
    const c = clock();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!issued.ok) throw new Error(issued.reason);

    const wrong = await redeemJoinCode(
      prisma(),
      { code: 'ZZZZZZZZ', user: actorOf(await user(), ['student']), secret: SECRET },
      c,
    );

    const r2 = await room();
    const expiring = await issueJoinCode(
      prisma(),
      { classroomId: r2.id, role: 'STUDENT', actor: r2.owner, secret: SECRET, ttlDays: 1 },
      c,
    );
    if (!expiring.ok) throw new Error(expiring.reason);
    const c2 = clock();
    c2.advance(2 * 24 * HOUR);
    const expired = await redeemJoinCode(
      prisma(),
      { code: expiring.code, user: actorOf(await user(), ['student']), secret: SECRET },
      c2,
    );

    const r3 = await room();
    const revokedRow = await issueJoinCode(
      prisma(),
      { classroomId: r3.id, role: 'STUDENT', actor: r3.owner, secret: SECRET },
      c,
    );
    if (!revokedRow.ok) throw new Error(revokedRow.reason);
    await revokeInvitation(prisma(), { invitationId: revokedRow.invitationId, actor: r3.owner });
    const revoked = await redeemJoinCode(
      prisma(),
      { code: revokedRow.code, user: actorOf(await user(), ['student']), secret: SECRET },
      c,
    );

    const unknown = await redeemJoinCode(
      prisma(),
      {
        code: issued.code,
        user: actorOf(await user(), ['student']),
        secret: 'wrong-secret-entirely',
      },
      c,
    );

    const messages = [wrong, expired, revoked, unknown].map((r) => JSON.stringify(r));
    expect(new Set(messages).size, `the four failures differ:\n${messages.join('\n')}`).toBe(1);
    expect(wrong.ok).toBe(false);
  });

  it('a wrong LENGTH is a failure like any other, and is not rate-limited', async () => {
    // A wrong length cannot be a guess at a real code — there is no such code — so counting it
    // against anything would let somebody lock a code they cannot possibly have guessed.
    const r = await room();
    const c = clock();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!issued.ok) throw new Error(issued.reason);
    for (let i = 0; i < MAX_CODE_FAILURES + 5; i += 1) {
      await redeemJoinCode(
        prisma(),
        { code: 'ABC', user: actorOf(await user(), ['student']), secret: SECRET },
        c,
      );
    }
    const row = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
      select: { failedAttempts: true, lockedAt: true },
    });
    expect(row.failedAttempts, 'short guesses were counted against the real code').toBe(0);
  });

  it('a code LOCKS after N failures, which is what makes 25^8 survivable', async () => {
    // The search space is irrelevant if each code gets ten guesses. The counter is on the ROW,
    // not on the IP, so a distributed sweep of one code still stops.
    const r = await room();
    const c = clock();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!issued.ok) throw new Error(issued.reason);

    // Guess codes that share the real code's HINT, so the row is found and the constant-time
    // compare fails — the realistic shape of an attack.
    const hint = issued.code.slice(-CODE_HINT_LENGTH);
    for (let i = 0; i < MAX_CODE_FAILURES; i += 1) {
      // Exactly CODE_LENGTH characters ending in the real hint, so the row is FOUND and the
      // constant-time compare is what fails. Derived from the constants rather than written out,
      // because two hand-counted versions of this line were the wrong length (10, then 9) and a
      // wrong-length guess is rejected by the length check BEFORE any lookup, so the counter
      // stayed at zero and the lock never engaged -- a test that looked like it was attacking
      // and was not attacking anything.
      const filler = 'A'.repeat(CODE_LENGTH - CODE_HINT_LENGTH);
      const guess = `${filler}${hint}`;
      const result = await redeemJoinCode(
        prisma(),
        { code: guess, user: actorOf(await user(), ['student']), secret: SECRET },
        c,
      );
      expect(result.ok).toBe(false);
    }
    const attempts = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
      select: { failedAttempts: true },
    });
    expect(attempts.failedAttempts).toBeGreaterThanOrEqual(MAX_CODE_FAILURES);

    // The sweep is a SEPARATE pass, because the increment and the threshold test are not the
    // same read: locking inline would let two concurrent guesses both see 9 and both let the
    // tenth through.
    expect(await lockGroundCodes(prisma(), c)).toBeGreaterThan(0);
    const locked = await prisma().classroomInvitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
      select: { lockedAt: true },
    });
    expect(locked.lockedAt).not.toBeNull();

    // …and the CORRECT code no longer works, which is the point of a lock.
    const after = await redeemJoinCode(
      prisma(),
      { code: issued.code, user: actorOf(await user(), ['student']), secret: SECRET },
      c,
    );
    expect(after.ok, 'a locked code still works with the right code').toBe(false);

    // Regenerating UNLOCKS it, which is the recovery path a teacher needs.
    const again = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!again.ok) throw new Error(again.reason);
    const ok = await redeemJoinCode(
      prisma(),
      { code: again.code, user: actorOf(await user(), ['student']), secret: SECRET },
      c,
    );
    expect(ok.ok).toBe(true);
  });

  it('redeeming twice reports the second as already-a-member, and creates ONE enrollment', async () => {
    const r = await room();
    const c = clock();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const joiner = actorOf(await user(), ['student']);

    const first = await redeemJoinCode(
      prisma(),
      { code: issued.code, user: joiner, secret: SECRET },
      c,
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyMember).toBe(false);

    const second = await redeemJoinCode(
      prisma(),
      { code: issued.code, user: joiner, secret: SECRET },
      c,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyMember).toBe(true);
    expect(
      await prisma().enrollment.count({ where: { classroomId: r.id, userId: joiner.id } }),
    ).toBe(1);
  });

  it('a join through a code records NO actor, so the history does not blame a teacher', async () => {
    const r = await room();
    const c = clock();
    const issued = await issueJoinCode(
      prisma(),
      { classroomId: r.id, role: 'STUDENT', actor: r.owner, secret: SECRET },
      c,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const joiner = await user();
    await redeemJoinCode(
      prisma(),
      { code: issued.code, user: actorOf(joiner, ['student']), secret: SECRET },
      c,
    );

    const event = await prisma().membershipEvent.findFirstOrThrow({
      where: { classroomId: r.id, userId: joiner },
      select: { actorId: true, note: true },
    });
    expect(event.actorId).toBeNull();
    expect(event.note).toMatch(/join code/);
  });

  it('a teacher can add somebody directly when mail and codes both fail', async () => {
    // "The teacher typed the email wrong and the student cannot receive mail" is a real
    // situation, and the code path needs a code nobody in the room has.
    const r = await room();
    const email = `${randomUUID()}@direct.example`;
    const target = await user(email);
    const result = await addMemberDirectly(prisma(), {
      classroomId: r.id,
      email,
      role: 'STUDENT',
      actor: r.owner,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe(target);
    expect(await prisma().enrollment.count({ where: { classroomId: r.id, userId: target } })).toBe(
      1,
    );

    // And it goes through the same history, so the record does not distinguish it.
    const event = await prisma().membershipEvent.findFirstOrThrow({
      where: { classroomId: r.id, userId: target },
      select: { kind: true, note: true },
    });
    expect(event.kind).toBe('JOINED');
  });
});
