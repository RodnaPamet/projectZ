import { NextRequest } from 'next/server';

import { listVenueFacets, listVenues } from '@/app-layer/repositories/venue';
import { GET as getNear } from '@/app/api/v1/venues/near/route';
import { GET as listVenuesRoute } from '@/app/api/v1/venues/route';
import { GET as legacyList } from '@/app/api/venues/route';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * /venues' filters against a real database (#357, #334): the sport is
 * checked before it reaches Prisma, a city matches however a club spelled it,
 * the search finds a city by its Bulgarian name, and the filters offer only
 * what some live venue has.
 */
describe('venue filters (#357)', () => {
  const db = prismaTestClient();

  async function makeVenue(
    tenantId: string,
    o: {
      slug: string;
      name: string;
      city: string;
      sport: 'PADEL' | 'TENNIS' | 'BADMINTON';
      status?: 'ACTIVE' | 'SUSPENDED';
    },
  ) {
    return asAppSuperuser(db, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId,
          slug: o.slug,
          name: o.name,
          status: o.status ?? 'ACTIVE',
          addressLine: '1',
          city: o.city,
          email: `${o.slug}@playerz.test`,
          lat: 42.7,
          lng: 23.3,
        },
      });
      await tx.resource.create({
        data: {
          tenantId,
          venueId: v.id,
          name: 'Court 1',
          sport: o.sport,
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return v;
    });
  }

  async function seedThree() {
    const a = await seedTenant();
    const b = await seedTenant();
    await makeVenue(a.tenantId, { slug: 'f-latin', name: 'Arena', city: 'Sofia', sport: 'PADEL' });
    await makeVenue(b.tenantId, {
      slug: 'f-cyr',
      name: 'Корт Изток',
      city: 'София',
      sport: 'TENNIS',
    });
    await makeVenue(b.tenantId, {
      slug: 'f-plov',
      name: 'Plovdiv Club',
      city: 'Plovdiv',
      sport: 'PADEL',
    });
  }

  const slugs = (r: { items: Array<{ slug: string }> }) => r.items.map((v) => v.slug).sort();

  describe('sport', () => {
    it('filters through the court join', async () => {
      await seedThree();
      expect(slugs(await listVenues(db, { sport: 'TENNIS' }))).toEqual(['f-cyr']);
    });

    it('GET /api/v1/venues refuses a sport outside the enum with a 400, not a 500 (#334)', async () => {
      const res = await listVenuesRoute(
        new NextRequest('http://t/api/v1/venues?sport=foo'),
        undefined,
      );
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('GET /api/v1/venues/near does too', async () => {
      const res = await getNear(
        new NextRequest('http://t/api/v1/venues/near?lat=42.7&lng=23.3&sport=__proto__'),
        undefined,
      );
      expect(res.status).toBe(400);
    });

    it('and so does the legacy /api/venues', async () => {
      const res = await legacyList(new NextRequest('http://t/api/venues?sport=foo'));
      expect(res.status).toBe(400);
    });

    it('a valid sport still answers 200 through the route', async () => {
      await seedThree();
      const res = await listVenuesRoute(
        new NextRequest('http://t/api/v1/venues?sport=PADEL'),
        undefined,
      );
      const body = (await res.json()) as { data: { items: Array<{ slug: string }> } };
      expect(res.status).toBe(200);
      expect(slugs(body.data)).toEqual(['f-latin', 'f-plov']);
    });
  });

  describe('city', () => {
    it('?city= finds a city however the club spelled it', async () => {
      await seedThree();
      expect(slugs(await listVenues(db, { city: 'Sofia' }))).toEqual(['f-cyr', 'f-latin']);
      expect(slugs(await listVenues(db, { city: 'софия' }))).toEqual(['f-cyr', 'f-latin']);
      expect(slugs(await listVenues(db, { city: 'Plovdiv' }))).toEqual(['f-plov']);
    });

    it('an unknown city is still an exact match, not a substring', async () => {
      const a = await seedTenant();
      await makeVenue(a.tenantId, { slug: 'f-kr', name: 'Beach', city: 'Кранево', sport: 'PADEL' });
      expect(slugs(await listVenues(db, { city: 'Кранево' }))).toEqual(['f-kr']);
      expect(slugs(await listVenues(db, { city: 'Кран' }))).toEqual([]);
    });
  });

  describe('text', () => {
    it('matches the venue name, case-insensitively', async () => {
      await seedThree();
      expect(slugs(await listVenues(db, { q: 'arena' }))).toEqual(['f-latin']);
      expect(slugs(await listVenues(db, { q: 'изток' }))).toEqual(['f-cyr']);
    });

    it('a Bulgarian city name finds venues stored in Latin, and the reverse', async () => {
      await seedThree();
      expect(slugs(await listVenues(db, { q: 'Соф' }))).toEqual(['f-cyr', 'f-latin']);
      expect(slugs(await listVenues(db, { q: 'sofia' }))).toEqual(['f-cyr', 'f-latin']);
      expect(slugs(await listVenues(db, { q: 'Пловдив' }))).toEqual(['f-plov']);
    });

    it('combines with the other filters', async () => {
      await seedThree();
      expect(slugs(await listVenues(db, { q: 'sofia', sport: 'PADEL' }))).toEqual(['f-latin']);
    });
  });

  describe('what the filters offer', () => {
    it('the cities and sports of live venues only, one entry per city', async () => {
      await seedThree();
      const a = await seedTenant();
      await makeVenue(a.tenantId, {
        slug: 'f-hidden',
        name: 'Hidden',
        city: 'Varna',
        sport: 'BADMINTON',
        status: 'SUSPENDED',
      });

      const facets = await runAsSuperuser((tx) => listVenueFacets(tx));
      // `Sofia` and `София` are one city, under the spelling ?city= carries.
      expect(facets.cities).toEqual(['Plovdiv', 'Sofia']);
      expect([...facets.sports].sort()).toEqual(['PADEL', 'TENNIS']);
    });
  });
});
