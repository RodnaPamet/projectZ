import {
  InvalidCoordinateError,
  MAX_RADIUS_KM,
  clampRadiusKm,
  nearVenues,
} from '@/app-layer/repositories/geo';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/** Real coordinates — the whole point is that the distance math is real. */
const SOFIA = { lat: 42.6977, lng: 23.3219 };
const PLOVDIV = { lat: 42.1354, lng: 24.7453 };
const VARNA = { lat: 43.2141, lng: 27.9147 };

describe('geo search (PostGIS)', () => {
  const prisma = prismaTestClient();

  async function venue(name: string, city: string, at: { lat: number; lng: number }) {
    const t = await seedTenant();
    return asAppSuperuser(prisma, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: name.toLowerCase().replace(/\W+/g, '-'),
          name,
          addressLine: '1',
          city,
          email: `${city}@playerz.test`,
          lat: at.lat,
          lng: at.lng,
        },
      });
      await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: v.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return v;
    });
  }

  it('a 5km search from Sofia finds Sofia and NOT Plovdiv (~133km away)', async () => {
    await venue('Sofia Padel', 'Sofia', SOFIA);
    await venue('Plovdiv Tennis', 'Plovdiv', PLOVDIV);

    const near = await nearVenues(prisma, { ...SOFIA, radiusKm: 5 });

    // If this used `geometry` instead of `geography`, the radius would be
    // measured in DEGREES and Plovdiv (1.4° away) would look like it was
    // inside a "5 unit" circle.
    expect(near.map((v) => v.city)).toEqual(['Sofia']);
  });

  it('reports a real distance in km', async () => {
    await venue('Sofia Padel', 'Sofia', SOFIA);
    await venue('Plovdiv Tennis', 'Plovdiv', PLOVDIV);

    const wide = await nearVenues(prisma, { ...SOFIA, radiusKm: MAX_RADIUS_KM });
    expect(wide.map((v) => v.city)).toEqual(['Sofia']); // Plovdiv is ~130km away, beyond the 100km cap

    const sofia = wide[0]!;
    expect(sofia.distanceKm).toBeLessThan(1);
  });

  it('orders NEAREST-FIRST across three real cities', async () => {
    await venue('Sofia Padel', 'Sofia', SOFIA);
    await venue('Plovdiv Tennis', 'Plovdiv', PLOVDIV);
    await venue('Varna Beach', 'Varna', VARNA);

    // A radius wide enough to catch all three, from Sofia.
    const all = await nearVenues(prisma, { ...SOFIA, radiusKm: MAX_RADIUS_KM, limit: 50 });
    expect(all.map((v) => v.city)).toEqual(['Sofia']);

    // Query from Plovdiv: Plovdiv first.
    const fromPlovdiv = await nearVenues(prisma, { ...PLOVDIV, radiusKm: 20 });
    expect(fromPlovdiv[0]!.city).toBe('Plovdiv');
  });

  it('the radius is CAPPED — an unauthenticated GET cannot ask for the planet', async () => {
    await venue('Sofia Padel', 'Sofia', SOFIA);

    // Without a cap this scans and sorts the whole table.
    expect(clampRadiusKm(20_000)).toBe(MAX_RADIUS_KM);
    expect(clampRadiusKm(undefined)).toBe(10);
    expect(clampRadiusKm(-5)).toBe(10);

    const huge = await nearVenues(prisma, { ...SOFIA, radiusKm: 20_000 });
    expect(huge.length).toBeLessThanOrEqual(50);
  });

  it('rejects out-of-range coordinates BEFORE they reach SQL', async () => {
    await expect(nearVenues(prisma, { lat: 999, lng: 23 })).rejects.toThrow(InvalidCoordinateError);
    await expect(nearVenues(prisma, { lat: 42, lng: -500 })).rejects.toThrow(
      InvalidCoordinateError,
    );
    await expect(nearVenues(prisma, { lat: NaN, lng: 23 })).rejects.toThrow(InvalidCoordinateError);
  });

  it('the trigger refreshes geog when lat/lng change', async () => {
    const v = await venue('Movable', 'Sofia', SOFIA);

    // Found near Sofia.
    expect((await nearVenues(prisma, { ...SOFIA, radiusKm: 5 })).map((x) => x.id)).toContain(v.id);

    // Move it to Varna. If geog were only set on INSERT, the venue would keep
    // showing up in Sofia searches forever — and nobody would notice except
    // the owner, losing bookings to a "near me" they never appear in.
    await asAppSuperuser(prisma, (tx) =>
      tx.venue.update({ where: { id: v.id }, data: { lat: VARNA.lat, lng: VARNA.lng } }),
    );

    expect((await nearVenues(prisma, { ...SOFIA, radiusKm: 5 })).map((x) => x.id)).not.toContain(
      v.id,
    );
    expect((await nearVenues(prisma, { ...VARNA, radiusKm: 5 })).map((x) => x.id)).toContain(v.id);
  });

  it('filters by sport through the resource join', async () => {
    const padel = await venue('Padel Place', 'Sofia', SOFIA);
    const t = await seedTenant();
    await asAppSuperuser(prisma, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: 'chess-club',
          name: 'Chess Club',
          addressLine: '2',
          city: 'Sofia',
          email: 'chess@playerz.test',
          lat: SOFIA.lat + 0.001,
          lng: SOFIA.lng,
        },
      });
      await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: v.id,
          name: 'Board 1',
          sport: 'CHESS',
          resourceType: 'BOARD_TABLE',
          surface: 'WOOD',
          basePriceCents: 500,
        },
      });
    });

    const chess = await nearVenues(prisma, { ...SOFIA, radiusKm: 5, sport: 'CHESS' });
    expect(chess.map((v) => v.name)).toEqual(['Chess Club']);

    const padelOnly = await nearVenues(prisma, { ...SOFIA, radiusKm: 5, sport: 'PADEL' });
    expect(padelOnly.map((v) => v.id)).toEqual([padel.id]);
  });

  it('a point in the middle of nowhere returns an empty list, not an error', async () => {
    await venue('Sofia Padel', 'Sofia', SOFIA);
    const atlantic = await nearVenues(prisma, { lat: 30, lng: -40, radiusKm: 50 });
    expect(atlantic).toEqual([]);
  });
});
