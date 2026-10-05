/**
 * Account enumeration through `POST /api/auth/forgot`.  (P14-T11)
 *
 * ## THIS IS THE EASIEST ENDPOINT IN THE PRODUCT TO GET WRONG
 *
 * The honest implementation is very tempting: 200 and "we sent a link" for a real address, 404 and
 * "no account with that address" for a fake one. That is a complete list of who has an account at
 * a school, obtainable by anyone who can type an address, and it is the mistake almost every
 * product makes exactly once. `GENERIC_DISPATCH` exists because the conditional sentence — "IF that
 * address has an account, a link is on its way" — is not a disclosure: a user WITH an account is
 * not confused by it, because the email arrives.
 *
 * ## THE ASSERTION THAT ACTUALLY MATTERS IS ABOUT WORK, NOT ABOUT WORDS
 *
 * Every test here that compares two responses would pass against a handler that returned one
 * constant string and did no work at all. So the load-bearing test is the one that counts DATABASE
 * WRITES: a real address and a fake one must cost the same number of queries. Writing nothing for
 * an unknown address is faster, and "faster" is the oracle that `password.ts` spends forty lines of
 * dummy argon2id closing at the credential layer and that this route would have reopened one layer
 * up.
 */

import { describe, expect, it, vi } from 'vitest';
import { RESPONSES } from '@/features/auth/flow';
import { type ForgotStore, requestReset, respondUniformly } from './forgot';

const T0 = 1_700_000_000_000;
const ADDRESS = 'student@school.example';

/** A monotonic clock that jumps, so the 300ms latency floor never actually sleeps. */
const clock = {
  now: () => T0,
  monotonic: (() => {
    let t = 0;
    return () => {
      t += 1000;
      return t;
    };
  })(),
};

function harness(existingUserId: string | null) {
  interface Row {
    toEmail: string;
    userId: string | null;
    status: string;
    dedupeKey: string;
    now: Date;
  }
  const rows: Row[] = [];
  const store = {
    findAccountIdByEmail: vi.fn(async () => existingUserId),
    enqueue: vi.fn(async (row: Row) => {
      rows.push(row);
    }),
  };
  return { deps: { store: store as unknown as ForgotStore, clock }, store, rows };
}

describe('the response is the same whether or not the address has an account', () => {
  it('same status and byte-identical body', async () => {
    const known = harness('u-1');
    const unknown = harness(null);

    const withAccount = await respondUniformly(
      known.deps,
      requestReset(known.deps, { email: ADDRESS }),
    );
    const withoutAccount = await respondUniformly(
      unknown.deps,
      requestReset(unknown.deps, { email: ADDRESS }),
    );

    expect(withoutAccount.status).toBe(withAccount.status);
    expect(await withoutAccount.text()).toBe(await withAccount.text());
  });

  it('and it is the CONDITIONAL sentence, not an admission', async () => {
    const unknown = harness(null);
    const response = await respondUniformly(
      unknown.deps,
      requestReset(unknown.deps, { email: ADDRESS }),
    );
    const body = (await response.json()) as { ok: boolean; message: string; code: string };
    expect(body.ok).toBe(true);
    expect(body.code).toBe('AUTH_OK');
    expect(body.message).toBe(RESPONSES.passwordResetSent);
    expect(body.message).toContain('If that address has an account');
    // And nothing that says what did NOT happen.
    for (const leak of ['no account', 'not found', 'unknown', 'registered', ADDRESS]) {
      expect(body.message.toLowerCase()).not.toContain(leak);
    }
  });

  it('and it is `no-store`, so a shared cache cannot serve one caller a stale answer', async () => {
    const h = harness(null);
    const response = await respondUniformly(h.deps, requestReset(h.deps, { email: ADDRESS }));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('and it sets NO cookie, so a successful dispatch cannot be told from a refusal', async () => {
    const known = harness('u-1');
    const response = await respondUniformly(
      known.deps,
      requestReset(known.deps, { email: ADDRESS }),
    );
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('both paths do the SAME WORK, which is the half a body assertion cannot reach', () => {
  it('one account lookup and one outbox write, whether or not the account exists', async () => {
    // The outbox row is the COOLDOWN as well as the queue entry, so the write has to happen on the
    // unknown path too: a per-account limiter cannot rate-limit an address that has no account,
    // which is `flow.ts:125-129`'s point and the reason the cooldown is keyed on the ADDRESS.
    const known = harness('u-1');
    const unknown = harness(null);
    await requestReset(known.deps, { email: ADDRESS });
    await requestReset(unknown.deps, { email: ADDRESS });

    expect(known.store.findAccountIdByEmail).toHaveBeenCalledTimes(1);
    expect(unknown.store.findAccountIdByEmail).toHaveBeenCalledTimes(1);
    expect(known.store.enqueue).toHaveBeenCalledTimes(1);
    expect(unknown.store.enqueue).toHaveBeenCalledTimes(1);
  });

  it('and the only difference between the two rows is the STATUS — never a skip', async () => {
    // `claimDueMessages` filters on `status = 'QUEUED'` (`packages/db/src/notifications.ts:479`),
    // so `SUPPRESSED` is inert: no mail goes to an address with no account. But the ROW EXISTS on
    // both paths, which is what keeps the work identical.
    const known = harness('u-1');
    const unknown = harness(null);
    await requestReset(known.deps, { email: ADDRESS });
    await requestReset(unknown.deps, { email: ADDRESS });
    expect(known.rows[0]?.status).toBe('QUEUED');
    expect(unknown.rows[0]?.status).toBe('SUPPRESSED');
    expect(unknown.rows[0]?.userId).toBeNull();
  });

  it('and the two rows share the address, the timestamp and the cooldown key', async () => {
    const known = harness('u-1');
    const unknown = harness(null);
    await requestReset(known.deps, { email: ADDRESS });
    await requestReset(unknown.deps, { email: ADDRESS });
    const a = known.rows[0];
    const b = unknown.rows[0];
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.toEmail).toBe(b?.toEmail);
    expect(a?.now.getTime()).toBe(b?.now.getTime());
  });
});

describe('the cooldown key', () => {
  it('does NOT contain the address, because the unique column is read by humans', async () => {
    // `throttleDedupeKey` hashes the identifier (`throttle.ts:240`), so a digest of every address
    // anybody has asked about cannot be reconstructed from this table by an operator or a dump.
    const h = harness(null);
    await requestReset(h.deps, { email: ADDRESS });
    const key = h.rows[0]?.dedupeKey ?? '';
    expect(key).not.toContain(ADDRESS);
    expect(key).toContain('auth.passwordResetRequested');
  });

  it('and is stable inside the window, which is what makes a repeat request a no-op', async () => {
    const h = harness(null);
    await requestReset(h.deps, { email: ADDRESS });
    await requestReset(h.deps, { email: ADDRESS });
    expect(h.rows[0]?.dedupeKey).toBe(h.rows[1]?.dedupeKey);
  });

  it('and changes once the window has passed, or the cooldown would never expire', async () => {
    const later = { ...clock, now: () => T0 + (RESPONSES.cooldownSeconds + 5) * 1000 };
    const h = harness(null);
    await requestReset(h.deps, { email: ADDRESS });
    await requestReset({ store: h.deps.store, clock: later }, { email: ADDRESS });
    expect(h.rows[0]?.dedupeKey).not.toBe(h.rows[1]?.dedupeKey);
  });

  it('and the address is NORMALISED, so changing the case cannot start a fresh cooldown', async () => {
    const h = harness(null);
    await requestReset(h.deps, { email: '  Student@School.Example ' });
    expect(h.rows[0]?.toEmail).toBe(ADDRESS);
  });
});
