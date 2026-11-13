import { NextRequest } from 'next/server';

import { GET as getVenue } from '@/app/api/v1/venues/[id]/route';
import { GET as getMap } from '@/app/api/v1/venues/map/route';
import { GET as getNear } from '@/app/api/v1/venues/near/route';
import { GET as listVenuesRoute } from '@/app/api/v1/venues/route';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The first /api/v1 routes, against a real database.
 *
 * These exercise the HANDLERS, not a mocked repository — because the thing most
 * likely to be wrong is not the mapping, it is the RLS binding. A public read
 * bound to the wrong context does not error; it returns an empty list that
 * reads exactly like "there are no venues in Sofia".
 */
describe('GET /api/v1/venues', () => {
  const db = prismaTestClient();
  let tenant: SeededTenant;
  let venueId: string;

  beforeEach(async () => {
    tenant = await seedTenant({}, db);
    const v = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `padel-palace-${Date.now()}`,
          name: 'Padel Palace',
          description: 'A nice club',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          phone: '+359000',
          lat: 42.6977123,
          lng: 23.3219456,
        },
      });
      await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return venue;
    });
    venueId = v.id;
  });

  const json = async (res: Response) => (await res.json()) as Record<string, never>;

  it('returns venues WITHOUT a tenant — the binding is the whole test', async () => {
    // `venue` has FORCE RLS keyed on app.tenant_id, and a public search has no
    // tenant. Bound as app_user this returns 0 rows and looks like an empty
    // city. It only works because the route binds asSuperuser.
    const res = await listVenuesRoute(
      new NextRequest('http://t/api/v1/venues?city=Sofia'),
      undefined,
    );
    const body = (await json(res)) as never as { data: { items: Array<{ id: string }> } };

    expect(res.status).toBe(200);
    expect(body.data.items.map((v) => v.id)).toContain(venueId);
  });

  it('the clubs map (#697): every bookable venue with its coordinates, no tenant', async () => {
    const res = await getMap(new NextRequest('http://t/api/v1/venues/map?sport=PADEL'), undefined);
    const body = (await json(res)) as never as {
      data: { venues: Array<{ id: string; lat: number; lng: number }>; truncated: boolean };
    };

    expect(res.status).toBe(200);
    const pin = body.data.venues.find((v) => v.id === venueId);
    expect(pin).toMatchObject({ lat: 42.6977123, lng: 23.3219456 });
    expect(body.data.truncated).toBe(false);
  });

  it('the clubs map leaves out a venue with nothing to book', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.resource.updateMany({ where: { venueId }, data: { status: 'SUSPENDED' } }),
    );
    const res = await getMap(new NextRequest('http://t/api/v1/venues/map'), undefined);
    const body = (await json(res)) as never as { data: { venues: Array<{ id: string }> } };
    expect(body.data.venues.map((v) => v.id)).not.toContain(venueId);
  });

  it('stamps the API version on a SUCCESS response, not only on errors', async () => {
    // A marker that appears only when something is already wrong is a marker
    // nobody sees.
    const res = await listVenuesRoute(new NextRequest('http://t/api/v1/venues'), undefined);
    expect(res.headers.get('X-API-Version')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('wraps the list in an object so it can grow a cursor later', async () => {
    const body = (await json(
      await listVenuesRoute(new NextRequest('http://t/api/v1/venues'), undefined),
    )) as never as { data: { items: unknown[]; nextCursor: string | null } };

    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data).toHaveProperty('nextCursor');
  });

  it("does NOT leak the club's internal fields", async () => {
    const raw = JSON.stringify(
      await json(await listVenuesRoute(new NextRequest('http://t/api/v1/venues'), undefined)),
    );

    // A DTO built by spreading a Prisma row publishes whatever the schema grows.
    expect(raw).not.toContain('internal@club.test');
    expect(raw).not.toContain(tenant.tenantId);
    expect(raw).not.toContain('cancellationPolicy');
  });
});

describe('GET /api/v1/venues/[id]', () => {
  const db = prismaTestClient();
  let venueId: string;

  beforeEach(async () => {
    const tenant = await seedTenant({}, db);
    const v = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `detail-${Date.now()}`,
          name: 'Detail Club',
          addressLine: '2 Court St',
          city: 'Sofia',
          email: 'd@club.test',
          lat: 42.6977123,
          lng: 23.3219456,
        },
      }),
    );
    venueId = v.id;
  });

  it('coerces Decimal to a NUMBER — a Swift client cannot decode a string', async () => {
    // Measured: JSON.stringify of a Prisma row gives {"lat":"42.6977123"}.
    // Decimal columns serialise as STRINGS, and a typed client fails at the
    // decoder, naming the whole response rather than the field.
    const res = await getVenue(new NextRequest('http://t/x'), {
      params: Promise.resolve({ id: venueId }),
    });
    const body = (await res.json()) as { data: { lat: unknown; lng: unknown; avgRating: unknown } };

    expect(typeof body.data.lat).toBe('number');
    expect(typeof body.data.lng).toBe('number');
    expect(typeof body.data.avgRating).toBe('number');
    expect(body.data.lat).toBeCloseTo(42.6977123, 6);
  });

  it('404s for an unknown id rather than returning a null payload', async () => {
    // A client that must branch on `data === null` will forget to, and render
    // an empty venue page.
    const res = await getVenue(new NextRequest('http://t/x'), {
      params: Promise.resolve({ id: 'cnosuchvenueaaaaaaaaaaaa' }),
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/v1/venues/near', () => {
  const db = prismaTestClient();

  // Two venues 1 and 3 km from the point, one with an indoor court (#667).
  async function seedTwo() {
    const tenant = await seedTenant({}, db);
    return asAppSuperuser(db, async (tx) => {
      await tx.venueOrg.update({
        where: { id: tenant.tenantId },
        data: { logoUrl: 'https://cdn.test/logo.webp' },
      });
      const make = async (name: string, lat: number, isIndoor: boolean, price: number) => {
        const venue = await tx.venue.create({
          data: {
            tenantId: tenant.tenantId,
            slug: `${name.toLowerCase()}-${Date.now()}`,
            name,
            addressLine: '1 Court St',
            city: 'София',
            email: 'internal@club.test',
            lat,
            lng: 23.32,
          },
        });
        await tx.resource.create({
          data: {
            tenantId: tenant.tenantId,
            venueId: venue.id,
            name: 'Court 1',
            sport: 'PADEL',
            surface: 'HARD',
            isIndoor,
            basePriceCents: price,
          },
        });
        return venue.id;
      };
      // ~1.1 km and ~3.3 km north of 42.70, 23.32.
      const near = await make('Near', 42.71, true, 3000);
      const far = await make('Far', 42.73, false, 2000);
      return { near, far, clubSlug: tenant.tenantSlug };
    });
  }

  const nearCall = async (q: string) => {
    const res = await getNear(
      new NextRequest(`http://t/api/v1/venues/near?lat=42.70&lng=23.32${q}`),
      undefined,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { venues: Array<Record<string, unknown>> } }).data.venues;
  };

  it('answers full venue cards plus the distance, nearest first (#667)', async () => {
    const { near, far, clubSlug } = await seedTwo();
    const venues = await nearCall('');
    expect(venues.map((v) => v.id)).toEqual([near, far]);
    expect(venues[0]).toMatchObject({
      clubSlug,
      sports: ['PADEL'],
      fromPriceCents: 3000,
      currency: 'EUR',
      clubLogoUrl: 'https://cdn.test/logo.webp',
      cover: null,
    });
    expect(venues[0]!.distanceKm).toBeCloseTo(1.1, 0);
  });

  it("applies the list's filters: city in any spelling, indoor, max price (#667)", async () => {
    const { near, far } = await seedTwo();
    expect((await nearCall('&city=Sofia')).map((v) => v.id)).toEqual([near, far]);
    expect((await nearCall('&city=Plovdiv')).map((v) => v.id)).toEqual([]);
    expect((await nearCall('&indoor=true')).map((v) => v.id)).toEqual([near]);
    expect((await nearCall('&maxPrice=2500')).map((v) => v.id)).toEqual([far]);
    expect((await nearCall('&limit=1')).map((v) => v.id)).toEqual([near]);
  });

  it('rejects a missing coordinate with a 400, not a PostGIS error', async () => {
    const res = await getNear(new NextRequest('http://t/api/v1/venues/near?lng=23.3'), undefined);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-numeric coordinate — Number("") is 0, which is off West Africa', async () => {
    const res = await getNear(
      new NextRequest('http://t/api/v1/venues/near?lat=abc&lng=23.3'),
      undefined,
    );
    expect(res.status).toBe(400);
  });

  it('CLAMPS an absurd radius and tells the client it did', async () => {
    // Unauthenticated, and the wrapper cannot rate-limit a GET. Without the cap
    // one request scans and sorts the whole table. Echoing the applied radius
    // stops a client rendering "nothing within 500km" when it never searched
    // that far.
    const res = await getNear(
      new NextRequest('http://t/api/v1/venues/near?lat=42.7&lng=23.3&radiusKm=20000'),
      undefined,
    );
    const body = (await res.json()) as { data: { radiusKm: number; paginated: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.radiusKm).toBe(100);
    expect(body.data.paginated).toBe(false);
  });
});
