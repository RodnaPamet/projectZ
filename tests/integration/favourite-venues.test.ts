import { NextRequest } from 'next/server';

import { DELETE as unheart, PUT as heart } from '@/app/api/v1/me/favourites/venues/[venueId]/route';
import { GET as listFavourites } from '@/app/api/v1/me/favourites/venues/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/** Favourite clubs (#672): the heart, «Любими», and whose rows are whose. */
const db = prismaTestClient();

const call = async <T>(
   
  route: (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>,
  method: string,
  who: TestIdentity | null,
  path: string,
  params: Record<string, string> = {},
) => {
  const res = await route(
    new NextRequest(`http://localhost:3000/api/v1${path}`, {
      method,
      headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
    }),
    { params: Promise.resolve(params) },
  );
  return { res, body: (await res.json()) as { data: T } };
};

describe('favourite venues (#672)', () => {
  let club: SeededTenant;
  let a: { venueId: string };
  let b: { venueId: string };
  let player: TestIdentity;
  let other: TestIdentity;

  const set = (who: TestIdentity, venueId: string, on: boolean) =>
    call<{ favourite: boolean }>(
      on ? heart : unheart,
      on ? 'PUT' : 'DELETE',
      who,
      `/me/favourites/venues/${venueId}`,
      {
        venueId,
      },
    );
  const list = (who: TestIdentity | null) =>
    call<{ ids: string[]; items: Array<{ id: string }> }>(
      listFavourites,
      'GET',
      who,
      '/me/favourites/venues',
    );

  beforeEach(async () => {
    club = await seedTenant({});
    a = await seedVenue(club.tenantId, { name: 'Алфа' });
    b = await seedVenue(club.tenantId, { name: 'Бета' });
    const sign = async (label: string) => {
      const id = await seedPlayer(db, club.tenantId, label);
      return signInAs(db, {
        userId: id,
        memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
      });
    };
    player = await sign('player');
    other = await sign('other');
  });

  it('401s signed out', async () => {
    expect((await list(null)).res.status).toBe(401);
  });

  it('hearts and unhearts, idempotently, newest heart first', async () => {
    expect((await set(player, a.venueId, true)).body.data).toEqual({ favourite: true });
    expect((await set(player, a.venueId, true)).body.data).toEqual({ favourite: true });
    await set(player, b.venueId, true);

    const both = await list(player);
    expect(both.res.status).toBe(200);
    expect(both.body.data.ids).toEqual([b.venueId, a.venueId]);
    expect(both.body.data.items.map((v) => v.id)).toEqual([b.venueId, a.venueId]);

    expect((await set(player, a.venueId, false)).body.data).toEqual({ favourite: false });
    expect((await set(player, a.venueId, false)).body.data).toEqual({ favourite: false });
    expect((await list(player)).body.data.ids).toEqual([b.venueId]);
  });

  it("is the person's own: another player sees none of it", async () => {
    await set(player, a.venueId, true);
    expect((await list(other)).body.data.ids).toEqual([]);
    // Owner-only RLS as well, not just the where clause.
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, other.userId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return tx.favouriteVenue.count();
    });
    expect(seen).toBe(0);
  });

  it('only a public venue can be hearted; one that stops being public drops out', async () => {
    expect((await set(player, 'nope', true)).res.status).toBe(404);
    await set(player, a.venueId, true);
    await asAppSuperuser(db, (tx) =>
      tx.venue.update({ where: { id: a.venueId }, data: { status: 'SUSPENDED' } }),
    );
    expect((await list(player)).body.data.items).toEqual([]);
  });
});
