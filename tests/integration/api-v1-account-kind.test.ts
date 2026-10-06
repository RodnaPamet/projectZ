import { NextRequest } from 'next/server';

import { POST as chooseRoute } from '@/app/api/v1/me/account-kind/route';
import { PATCH as patchMeRoute } from '@/app/api/v1/me/route';

import { signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * #360: "Играч или треньор?" — `POST /api/v1/me/account-kind`, once.
 *
 * The kind is what an account IS (#263), so the tests are about the second
 * write as much as the first: refused through this route, refused through
 * `PATCH /me`, and refused under a race.
 */
const db = prismaTestClient();

interface Body {
  data: { accountKind: string | null; landing: { reason: string } };
  error: { code: string; details?: { field?: string } };
}

const choose = async (who: TestIdentity | null, body: unknown) => {
  const res = await chooseRoute(
    new NextRequest('http://localhost:3000/api/v1/me/account-kind', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { res, body: (await res.json()) as Body };
};

async function fresh(kind: 'PLAYER' | 'COACH' | 'CLUB' | null = null): Promise<TestIdentity> {
  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email: `new-${Math.random().toString(36).slice(2)}@playerz.test`, accountKind: kind },
      select: { id: true },
    }),
  );
  return signInAs(db, { userId: u.id, memberships: [] });
}

const kindOf = async (userId: string) =>
  (
    await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { accountKind: true } }),
    )
  ).accountKind;

describe('POST /api/v1/me/account-kind (#360)', () => {
  it('sets the kind of a new account, and answers the account', async () => {
    const me = await fresh();
    const { res, body } = await choose(me, { kind: 'PLAYER' });

    expect(res.status).toBe(200);
    expect(body.data.accountKind).toBe('PLAYER');
    expect(body.data.landing.reason).toBe('player');
    expect(await kindOf(me.userId)).toBe('PLAYER');
  });

  it('sets COACH, which lands on the player UI until the coach profile ships', async () => {
    const me = await fresh();
    const { body } = await choose(me, { kind: 'COACH' });
    expect(body.data.accountKind).toBe('COACH');
    expect(body.data.landing.reason).toBe('coach');
  });

  it('is set ONCE: a second choice is refused, whatever it asks for', async () => {
    const me = await fresh();
    await choose(me, { kind: 'PLAYER' });

    for (const kind of ['COACH', 'PLAYER']) {
      const { res, body } = await choose(me, { kind });
      expect(res.status).toBe(409);
      expect(body.error.code).toBe('ACCOUNT_KIND_ALREADY_SET');
    }
    expect(await kindOf(me.userId)).toBe('PLAYER');
  });

  it('refuses an account that already had a kind before #360', async () => {
    const player = await fresh('PLAYER');
    const { res } = await choose(player, { kind: 'COACH' });
    expect(res.status).toBe(409);
    expect(await kindOf(player.userId)).toBe('PLAYER');
  });

  it('two first choices at once: exactly one wins', async () => {
    const me = await fresh();
    const [a, b] = await Promise.all([
      choose(me, { kind: 'PLAYER' }),
      choose(me, { kind: 'COACH' }),
    ]);
    expect([a.res.status, b.res.status].sort()).toEqual([200, 409]);
    const winner = a.res.status === 200 ? 'PLAYER' : 'COACH';
    expect(await kindOf(me.userId)).toBe(winner);
  });

  it('never offers CLUB, and refuses any other key', async () => {
    const me = await fresh();
    const club = await choose(me, { kind: 'CLUB' });
    expect(club.res.status).toBe(400);
    expect(club.body.error.details?.field).toBe('kind');

    const extra = await choose(me, { kind: 'PLAYER', role: 'OWNER' });
    expect(extra.res.status).toBe(400);
    expect(extra.body.error.details?.field).toBe('role');
    expect(await kindOf(me.userId)).toBeNull();
  });

  it('cannot be bypassed through PATCH /me', async () => {
    const me = await fresh();
    await choose(me, { kind: 'PLAYER' });

    const res = await patchMeRoute(
      new NextRequest('http://localhost:3000/api/v1/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${me.bearer}` },
        body: JSON.stringify({ accountKind: 'COACH' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect(await kindOf(me.userId)).toBe('PLAYER');
  });

  it('refuses PLAYER for an older undecided account that coaches somewhere', async () => {
    const t = await seedTenant({});
    const me = await fresh();
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { userId: me.userId, tenantId: t.tenantId, role: 'COACH', status: 'ACTIVE' },
      }),
    );
    const { res, body } = await choose(me, { kind: 'PLAYER' });
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('ACCOUNT_KIND_NOT_ALLOWED');
    expect(await kindOf(me.userId)).toBeNull();
  });

  it('401s signed out', async () => {
    expect((await choose(null, { kind: 'PLAYER' })).res.status).toBe(401);
  });
});
