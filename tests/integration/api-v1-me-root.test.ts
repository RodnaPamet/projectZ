import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';

import { GET as me } from '@/app/api/v1/me/route';
import { config as middlewareConfig, middleware } from '@/middleware';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/me — the account's kind and why it lands where it does (#252,
 * by account kind since #263), with no web path in the answer.
 *
 * Through the real handler with a real bearer over a real `user_session` row,
 * so `contextFromRequest`'s session check runs. One case at the end goes
 * through the real middleware too: every other test calls the handler
 * directly, which is how #250 hid behind an edge nobody exercised.
 */
const db = prismaTestClient();

interface MeBody {
  data: {
    id: string;
    name: string | null;
    email: string;
    locale: string;
    accountKind: string | null;
    landing: { reason: string; club: { slug: string; name: string; role: string } | null };
  };
}

const call = (headers: Record<string, string> = {}) =>
  me(new NextRequest('http://localhost:3000/api/v1/me', { headers }), {
    params: Promise.resolve({}),
  });

async function bearerFor(userId: string): Promise<string> {
  return (await signInAs(db, { userId, memberships: [] })).bearer;
}

async function meOf(userId: string): Promise<MeBody['data']> {
  const res = await call({ authorization: `Bearer ${await bearerFor(userId)}` });
  expect(res.status).toBe(200);
  return ((await res.json()) as MeBody).data;
}

describe('GET /api/v1/me', () => {
  it('401s signed out, through the error envelope', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('a PLAYER: reason "player", no club — and no web path anywhere in the body', async () => {
    const userId = await seedAccount('PLAYER');
    const data = await meOf(userId);

    expect(data).toMatchObject({
      id: userId,
      accountKind: 'PLAYER',
      locale: 'bg',
      landing: { reason: 'player', club: null },
    });
    expect(data.email).toMatch(/@playerz\.test$/);
    // THE POINT of the reason: clients map it to their own screens. A path
    // in the payload would be one they start to parse.
    expect(JSON.stringify(data)).not.toMatch(/"\/|href/);
  });

  it('a CLUB account: reason "club", its one club by slug and name, and its role there', async () => {
    const t = await seedTenant({});
    const club = await asAppSuperuser(db, (tx) =>
      tx.venueOrg.findUniqueOrThrow({ where: { id: t.tenantId }, select: { name: true } }),
    );

    const data = await meOf(t.userId);

    expect(data.accountKind).toBe('CLUB');
    expect(data.landing).toEqual({
      reason: 'club',
      club: { slug: t.tenantSlug, name: club.name, role: 'OWNER' },
    });
  });

  it('a CLUB account whose club is suspended: "club-unavailable", and no club', async () => {
    const t = await seedTenant({});
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: t.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const data = await meOf(t.userId);
    expect(data.accountKind).toBe('CLUB');
    expect(data.landing).toEqual({ reason: 'club-unavailable', club: null });
  });

  it('a COACH: reason "coach", and no club while there is no coach UI', async () => {
    const userId = await seedAccount('COACH');
    const data = await meOf(userId);
    expect(data.accountKind).toBe('COACH');
    expect(data.landing).toEqual({ reason: 'coach', club: null });
  });

  it('UNDECIDED with a club role: accountKind null, reason "undecided", the club it lands on', async () => {
    // What #263's migration left alone. Made the way the tenant /me test makes
    // one: an owner whose kind is cleared.
    const t = await seedTenant({});
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: t.userId }, data: { accountKind: null } }),
    );

    const data = await meOf(t.userId);
    expect(data.accountKind).toBeNull();
    expect(data.landing.reason).toBe('undecided');
    expect(data.landing.club).toMatchObject({ slug: t.tenantSlug, role: 'OWNER' });
  });

  it('UNDECIDED with no club role: reason "undecided", no club', async () => {
    const userId = await seedAccount(null);
    const data = await meOf(userId);
    expect(data.accountKind).toBeNull();
    expect(data.landing).toEqual({ reason: 'undecided', club: null });
  });

  it('answers from the DATABASE: a kind decided after sign-in shows on the next call', async () => {
    // The token is minted while the account is undecided; nothing in it says
    // PLAYER. A claim-reading implementation would still say undecided.
    const userId = await seedAccount(null);
    const bearer = await bearerFor(userId);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: userId }, data: { accountKind: 'PLAYER' } }),
    );

    const res = await call({ authorization: `Bearer ${bearer}` });
    const { data } = (await res.json()) as MeBody;
    expect(data.accountKind).toBe('PLAYER');
    expect(data.landing.reason).toBe('player');
  });

  it('409 VIEWER_CHANGED when the page was rendered for somebody else (T15)', async () => {
    const userId = await seedAccount('PLAYER');
    const bearer = await bearerFor(userId);

    const stale = await call({
      authorization: `Bearer ${bearer}`,
      'x-playerz-viewer': 'cuser_someone_else',
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('VIEWER_CHANGED');

    // …and the same header naming the caller is no obstacle at all.
    const same = await call({ authorization: `Bearer ${bearer}`, 'x-playerz-viewer': userId });
    expect(same.status).toBe(200);
  });

  describe('through the real middleware', () => {
    /** The middleware first, and the route only if it let the request on. */
    async function send(headers: Record<string, string>) {
      const url = 'http://localhost:3000/api/v1/me';
      expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url: '/api/v1/me' })).toBe(
        true,
      );

      const edge = await middleware(new NextRequest(url, { headers }));
      if (edge.headers.get('x-middleware-next') !== '1') {
        return { by: 'edge' as const, status: edge.status, body: await edge.json() };
      }
      const res = await call(headers);
      return { by: 'route' as const, status: res.status, body: await res.json() };
    }

    it('a native bearer reaches the route and gets its own account', async () => {
      const t = await seedTenant({});
      const answer = await send({ authorization: `Bearer ${await bearerFor(t.userId)}` });

      expect(answer.by).toBe('route');
      expect(answer.status).toBe(200);
      expect((answer.body as MeBody).data.landing.club?.slug).toBe(t.tenantSlug);
    });

    it('signed out: the edge passes it (no club in the path) and the ROUTE says 401', async () => {
      // Pinned because it is a choice: `/api/v1/me` names no club, so the edge
      // has nothing to check, and the refusal is the handler's. Were the edge
      // ever to start refusing it, this would say so.
      const answer = await send({});
      expect(answer).toMatchObject({ by: 'route', status: 401 });
    });
  });
});
