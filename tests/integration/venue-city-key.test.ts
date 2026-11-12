import { NextRequest } from 'next/server';

import { GET as getFacets } from '@/app/api/v1/venues/facets/route';
import { GET as listVenuesRoute } from '@/app/api/v1/venues/route';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Canonical cities (#667, P86): `venue.cityKey` is filled from the typed
 * `city` by a trigger, so `Sofia` and `София` are one city to the phone.
 */
describe('venue.cityKey', () => {
  const db = prismaTestClient();

  async function venue(city: string) {
    const tenant = await seedTenant({}, db);
    return asAppSuperuser(db, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `v-${Math.random().toString(36).slice(2, 8)}`,
          name: `Venue in ${city}`,
          addressLine: '1 Court St',
          city,
          email: 'internal@club.test',
          lat: 42.7,
          lng: 23.3,
        },
      });
      await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: v.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2000,
        },
      });
      return v.id;
    });
  }

  const key = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.venue.findUniqueOrThrow({ where: { id }, select: { cityKey: true } }),
    );

  it('is filled on insert, in any spelling, and null for a city outside the list', async () => {
    expect(await key(await venue('Sofia'))).toEqual({ cityKey: 'sofia' });
    expect(await key(await venue('  софия '))).toEqual({ cityKey: 'sofia' });
    expect(await key(await venue('Стара Загора'))).toEqual({ cityKey: 'staraZagora' });
    expect(await key(await venue('Tryavna'))).toEqual({ cityKey: null });
  });

  it('follows an edit of the city', async () => {
    const id = await venue('Sofia');
    await asAppSuperuser(db, (tx) => tx.venue.update({ where: { id }, data: { city: 'Пловдив' } }));
    expect(await key(id)).toEqual({ cityKey: 'plovdiv' });
  });

  it('goes out on every card with both names, and `?city=` takes the key', async () => {
    const latin = await venue('Sofia');
    const cyrillic = await venue('София');
    await venue('Plovdiv');

    const res = await listVenuesRoute(
      new NextRequest('http://t/api/v1/venues?city=sofia'),
      undefined,
    );
    const items = ((await res.json()) as { data: { items: Array<Record<string, unknown>> } }).data
      .items;
    expect(items.map((i) => i.id).sort()).toEqual([latin, cyrillic].sort());
    for (const i of items) {
      expect(i).toMatchObject({ cityKey: 'sofia', cityNames: { bg: 'София', en: 'Sofia' } });
    }
  });

  it('facets offer one city per key, with what `?city=` takes', async () => {
    await venue('Sofia');
    await venue('София');
    await venue('Tryavna');

    const res = await getFacets(new NextRequest('http://t/api/v1/venues/facets'), undefined);
    expect(res.status).toBe(200);
    const { cities, sports } = (
      (await res.json()) as {
        data: { cities: Array<{ value: string; key: string | null }>; sports: string[] };
      }
    ).data;
    expect(cities).toEqual(
      expect.arrayContaining([
        { value: 'sofia', key: 'sofia', names: { bg: 'София', en: 'Sofia' } },
        { value: 'Tryavna', key: null, names: { bg: 'Tryavna', en: 'Tryavna' } },
      ]),
    );
    expect(cities.filter((c) => c.key === 'sofia')).toHaveLength(1);
    expect(sports).toEqual(['PADEL']);
  });
});
