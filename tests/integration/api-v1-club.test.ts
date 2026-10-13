import { NextRequest } from 'next/server';

import { GET } from '@/app/api/v1/clubs/[slug]/route';

import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/clubs/{slug} (#411): a club's public page for the native app,
 * anonymous, from the loader the web's /clubs/{slug} uses.
 */
const db = prismaTestClient();

const get = (slug: string) =>
  GET(new NextRequest(`http://t/api/v1/clubs/${slug}`), {
    params: Promise.resolve({ slug }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

async function publicClub() {
  const club = await seedTenant({ name: 'Клуб Изток' }, db);
  const venue = await seedVenue(club.tenantId, { name: 'Изток Кортове' });
  await asAppSuperuser(db, (tx) =>
    tx.venue.update({
      where: { id: venue.venueId },
      data: { publicSlug: `iztok-${club.tenantId.slice(-6)}` },
    }),
  );
  return { club, venue };
}

describe('GET /api/v1/clubs/{slug} (#411)', () => {
  it('answers an anonymous caller with the club and its venues', async () => {
    const { club, venue } = await publicClub();
    const res = await get(club.tenantSlug);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: club.tenantId,
      slug: club.tenantSlug,
      name: 'Клуб Изток',
    });
    expect(res.body.data.venues).toHaveLength(1);
    expect(res.body.data.venues[0]).toMatchObject({ id: venue.venueId, name: 'Изток Кортове' });
    expect(res.body.data.venues[0].sports).toEqual(expect.any(Array));
  });

  it('is a 404 for a suspended club, as for one that does not exist', async () => {
    const { club } = await publicClub();
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    expect((await get(club.tenantSlug)).status).toBe(404);
    expect((await get('no-such-club')).status).toBe(404);
  });
});
