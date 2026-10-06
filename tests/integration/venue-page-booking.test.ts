import { NextRequest } from 'next/server';

import { getVenueByPublicSlug } from '@/app-layer/repositories/venue';
import { GET as myBookingsRoute } from '@/app/api/v1/me/bookings/route';
import { POST as createRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { GET as availabilityRoute } from '@/app/api/v1/venues/[id]/availability/route';
import { GET as venuesRoute } from '@/app/api/v1/venues/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, withTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The venue page's data path (#355), against a real database: the public slug
 * P40 writes, the slot lengths availability now offers (Q16), and the round
 * trip the page makes — read the day, book one of its offers, find it in the
 * player's bookings.
 */

// 2036-07-16 is a Wednesday. Sofia is UTC+3 in July: 09:00 local = 06:00Z.
const DAY = '2036-07-16';
const AT = (hourLocal: number) => `2036-07-16T${String(hourLocal - 3).padStart(2, '0')}:00:00Z`;

type Slot = {
  startTs: string;
  endTs: string;
  available: boolean;
  priceCents: number;
  durations?: Array<{ minutes: number; endTs: string; priceCents: number }>;
};
type Availability = {
  data: { resources: Array<{ resourceId: string; maxBookingMinutes: number; slots: Slot[] }> };
};

describe('the venue page (#355)', () => {
  const db = prismaTestClient();

  let tenant: SeededTenant;
  let player: TestIdentity;
  let venueId: string;
  let resourceId: string;
  let venueSlug: string;

  async function seedVenueAt(t: SeededTenant, slug: string) {
    return asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug,
          name: `Venue ${slug}`,
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          lat: 42.6977,
          lng: 23.3219,
          timezone: 'Europe/Sofia',
        },
      });
      const resource = await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
          minBookingMinutes: 60,
          maxBookingMinutes: 180,
          slotStepMinutes: 60,
        },
      });
      await tx.resourceAvailability.create({
        data: {
          tenantId: t.tenantId,
          resourceId: resource.id,
          dayOfWeek: 3,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T17:00:00Z'),
        },
      });
      return { venue, resource };
    });
  }

  beforeEach(async () => {
    tenant = await seedTenant({});
    venueSlug = `centre-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await seedVenueAt(tenant, venueSlug);
    venueId = seeded.venue.id;
    resourceId = seeded.resource.id;

    const playerId = await seedPlayer(db, tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });
  });

  const availability = async (): Promise<Availability> => {
    const res = await availabilityRoute(
      new NextRequest(`http://t/api/v1/venues/${venueId}/availability?date=${DAY}`),
      { params: Promise.resolve({ id: venueId }) },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Availability;
  };

  const book = async (body: Record<string, unknown>, key = `key-${Math.random()}`) => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${player.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );
    return {
      status: res.status,
      body: (await res.json()) as { data?: { id: string; totalCents: number } },
    };
  };

  describe('publicSlug (P40)', () => {
    it('is filled on insert, and is unique across clubs where `slug` is not', async () => {
      const other = await seedTenant({});
      // Another club names its venue the same — allowed, `slug` is per club.
      const twin = await seedVenueAt(other, venueSlug);

      const [mine, theirs] = await asAppSuperuser(db, (tx) =>
        Promise.all([
          tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { publicSlug: true } }),
          tx.venue.findUniqueOrThrow({
            where: { id: twin.venue.id },
            select: { publicSlug: true },
          }),
        ]),
      );
      expect(mine.publicSlug).toBe(venueSlug);
      // The second gets the club's slug appended rather than a collision.
      expect(theirs.publicSlug).toBe(`${venueSlug}-${other.tenantSlug}`);

      // Each public slug names its own venue.
      const found = await asAppSuperuser(db, (tx) =>
        Promise.all([
          getVenueByPublicSlug(tx, mine.publicSlug!),
          getVenueByPublicSlug(tx, theirs.publicSlug!),
        ]),
      );
      expect(found.map((v) => v?.id)).toEqual([venueId, twin.venue.id]);
    });

    it('is filled for a venue written by a tenant-bound app_user, who cannot see other clubs', async () => {
      const other = await seedTenant({});
      // Written inside the OTHER club's RLS binding: it cannot see `venueSlug`
      // at this club, so only a check that runs past RLS finds the clash.
      const created = await withTenant(other.tenantId, (tx) =>
        tx.venue.create({
          data: {
            tenantId: other.tenantId,
            slug: venueSlug,
            name: 'Bound',
            addressLine: '2 Court St',
            city: 'Sofia',
            email: 'internal@club.test',
            lat: 42.6977,
            lng: 23.3219,
          },
          select: { publicSlug: true },
        }),
      );
      expect(created.publicSlug).toBe(`${venueSlug}-${other.tenantSlug}`);
    });

    it('normalises what it is given and never changes once set', async () => {
      const odd = await seedVenueAt(tenant, `Odd Slug__${venueSlug}`);
      const row = await asAppSuperuser(db, (tx) =>
        tx.venue.findUniqueOrThrow({ where: { id: odd.venue.id }, select: { publicSlug: true } }),
      );
      expect(row.publicSlug).toBe(`odd-slug-${venueSlug}`);

      await asAppSuperuser(db, (tx) =>
        tx.venue.update({ where: { id: odd.venue.id }, data: { slug: 'renamed' } }),
      );
      const after = await asAppSuperuser(db, (tx) =>
        tx.venue.findUniqueOrThrow({ where: { id: odd.venue.id }, select: { publicSlug: true } }),
      );
      expect(after.publicSlug).toBe(`odd-slug-${venueSlug}`);
    });

    it('is on every row of GET /venues, so the cards can link', async () => {
      const res = await venuesRoute(new NextRequest('http://t/api/v1/venues?limit=50'), {
        params: Promise.resolve({}),
      });
      const body = (await res.json()) as {
        data: { items: Array<{ id: string; publicSlug: string }> };
      };
      expect(body.data.items.find((v) => v.id === venueId)?.publicSlug).toBe(venueSlug);
    });
  });

  describe('durations on the availability endpoint (Q16)', () => {
    it('offers every free length up to the maximum, priced by the booking quote', async () => {
      const { data } = await availability();
      const court = data.resources[0]!;
      expect(court.maxBookingMinutes).toBe(180);

      const nine = court.slots.find((s) => s.startTs === AT(9))!;
      expect(nine.durations).toEqual([
        { minutes: 60, endTs: AT(10), priceCents: 2400 },
        { minutes: 120, endTs: AT(11), priceCents: 4800 },
        { minutes: 180, endTs: AT(12), priceCents: 7200 },
      ]);

      // Closing at 17:00 cuts the lengths short: 16:00 is one hour only.
      const four = court.slots.find((s) => s.startTs === AT(16))!;
      expect(four.durations?.map((d) => d.minutes)).toEqual([60]);
    });

    it('stops a length at the next booking, and gives a taken slot none', async () => {
      const taken = await book({ resourceId, startTs: AT(11), endTs: AT(12) });
      expect(taken.status).toBe(201);

      const { data } = await availability();
      const slots = data.resources[0]!.slots;
      expect(slots.find((s) => s.startTs === AT(9))!.durations?.map((d) => d.minutes)).toEqual([
        60, 120,
      ]);
      const eleven = slots.find((s) => s.startTs === AT(11))!;
      expect(eleven.available).toBe(false);
      expect(eleven.durations).toBeUndefined();
    });
  });

  it('availability → book an offer → it is in the player’s bookings, at the price shown', async () => {
    const { data } = await availability();
    const offer = data.resources[0]!.slots.find((s) => s.startTs === AT(13))!.durations![1]!;

    const made = await book({ resourceId, startTs: AT(13), endTs: offer.endTs });
    expect(made.status).toBe(201);
    expect(made.body.data!.totalCents).toBe(offer.priceCents);

    // The slot left the grid.
    const after = await availability();
    const thirteen = after.data.resources[0]!.slots.find((s) => s.startTs === AT(13))!;
    expect(thirteen.available).toBe(false);

    const res = await myBookingsRoute(
      new NextRequest('http://t/api/v1/me/bookings', {
        headers: { authorization: `Bearer ${player.bearer}` },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const mine = (await res.json()) as {
      data: { items: Array<{ id: string; status: string; startTs: string; endTs: string }> };
    };
    expect(mine.data.items).toContainEqual(
      expect.objectContaining({
        id: made.body.data!.id,
        status: 'CONFIRMED',
        startTs: AT(13),
        endTs: offer.endTs,
      }),
    );
  });

  it('a double tap — the same Idempotency-Key twice at once — books once', async () => {
    const key = `double-${Math.random()}`;
    const body = { resourceId, startTs: AT(14), endTs: AT(15) };
    const results = await Promise.all([book(body, key), book(body, key)]);

    // One creates (201). The other replays it (200) or lost the race on the
    // key and is told to retry (409 IDEMPOTENCY_RACE) — never a second booking.
    expect(results.map((r) => r.status).sort()).toEqual(expect.arrayContaining([201]));
    for (const r of results) expect([200, 201, 409]).toContain(r.status);

    const count = await asAppSuperuser(db, (tx) =>
      tx.booking.count({ where: { resourceId, startTs: new Date(AT(14)) } }),
    );
    expect(count).toBe(1);

    // And the retry the sheet sends after a lost response gets that booking.
    const retry = await book(body, key);
    expect(retry.status).toBe(200);
    expect(retry.body.data!.id).toBe(results.find((r) => r.status === 201)!.body.data!.id);
  });
});
