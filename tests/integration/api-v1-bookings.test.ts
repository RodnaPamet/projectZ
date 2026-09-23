import { NextRequest } from 'next/server';

import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { GET as availabilityRoute } from '@/app/api/v1/venues/[id]/availability/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The booking write path, against a real database.
 *
 * The parts that cannot be unit tested are the ones that matter here: the
 * EXCLUDE constraint arbitrating a genuine race, RLS scoping the reads, and a
 * real bearer token surviving `getToken` + `checkSession`.
 */
describe('POST /api/v1/t/:slug/bookings', () => {
  const db = prismaTestClient();

  let tenant: SeededTenant;
  let owner: TestIdentity;
  let player: TestIdentity;
  let venueId: string;
  let resourceId: string;

  // 2026-07-15 is a Wednesday. Sofia is UTC+3 in July: 09:00 local = 06:00Z.
  const NINE_AM = '2026-07-15T06:00:00Z';
  const TEN_AM = '2026-07-15T07:00:00Z';

  beforeEach(async () => {
    tenant = await seedTenant({});

    const seeded = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `book-club-${Date.now()}`,
          name: 'Book Club',
          description: 'Courts',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          phone: '+359000',
          lat: 42.6977123,
          lng: 23.3219456,
          timezone: 'Europe/Sofia',
        },
      });

      const resource = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
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
          tenantId: tenant.tenantId,
          resourceId: resource.id,
          dayOfWeek: 3,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T17:00:00Z'),
        },
      });

      return { venue, resource };
    });

    venueId = seeded.venue.id;
    resourceId = seeded.resource.id;

    const memberships = [
      { tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'OWNER' },
    ];
    owner = await signInAs(db, { userId: tenant.userId, memberships });

    const playerId = await seedPlayer(db, tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });
  });

  const create = async (
    who: TestIdentity,
    body: Record<string, unknown>,
    idempotencyKey = `key-${Math.random()}`,
  ) => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${who.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );
    return { res, body: (await res.json()) as never };
  };

  type Created = { data: { id: string; totalCents: number; status: string } };
  type ApiError = { error: { code: string; message: string } };

  it('creates a booking and prices it SERVER-SIDE', async () => {
    const { res, body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
    });

    expect(res.status).toBe(201);
    expect((body as Created).data.totalCents).toBe(2400);
    expect((body as Created).data.status).toBe('PENDING');
  });

  it('IGNORES a price supplied by the client', async () => {
    // The whole reason the route quotes rather than forwards. A client that
    // sends its own total must not be able to buy a €24 court for a cent —
    // and nothing downstream would object, because 1 is a perfectly valid
    // amount, it is just not the club's price.
    const { res, body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
      totalCents: 1,
      priceCents: 1,
    });

    expect(res.status).toBe(201);
    expect((body as Created).data.totalCents).toBe(2400);
  });

  it('charges per unit for a multi-hour booking', async () => {
    const { body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: '2026-07-15T09:00:00Z', // three hours
    });

    expect((body as Created).data.totalCents).toBe(7200);
  });

  it('quotes the same price the availability endpoint advertised', async () => {
    // Cross-endpoint consistency, end to end. If these drift the app shows one
    // number and charges another, and nothing fails.
    const availRes = await availabilityRoute(
      new NextRequest(`http://t/api/v1/venues/${venueId}/availability?date=2026-07-15`),
      { params: Promise.resolve({ id: venueId }) },
    );
    const avail = (await availRes.json()) as {
      data: {
        resources: Array<{ slots: Array<{ startTs: string; endTs: string; priceCents: number }> }>;
      };
    };

    const slot = avail.data.resources[0]!.slots[0]!;

    const { body } = await create(player, {
      resourceId,
      startTs: slot.startTs,
      endTs: slot.endTs,
    });

    expect((body as Created).data.totalCents).toBe(slot.priceCents);
  });

  it('returns the SAME booking for a repeated idempotency key', async () => {
    // The player taps once, the network stalls, the app retries. A second
    // booking here is a second charge.
    const key = `same-key-${Date.now()}`;

    const first = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);
    const second = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);

    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(200); // replay, not a new creation
    expect((second.body as Created).data.id).toBe((first.body as Created).data.id);
  });

  it('requires an Idempotency-Key rather than inventing one', async () => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${player.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ resourceId, startTs: NINE_AM, endTs: TEN_AM }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );

    expect(res.status).toBe(400);
  });

  it('409s when the slot was taken, via the EXCLUDE constraint', async () => {
    await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

    const { res, body } = await create(owner, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

    expect(res.status).toBe(409);
    expect((body as ApiError).error.code).toBe('SLOT_TAKEN');
  });

  it('a burst of simultaneous attempts yields exactly one booking', async () => {
    // What this DOES prove: eight overlapping requests produce one 201 and
    // seven 409s, and the 23P01 from the exclusion constraint is mapped all
    // the way out to SLOT_TAKEN rather than escaping as a 500.
    //
    // What it does NOT prove, checked rather than assumed: it still passes
    // when `createBooking` is given the check-then-insert anti-pattern its own
    // doc comment warns against. These requests do not interleave finely
    // enough between the read and the insert to expose it, so a test claiming
    // otherwise would be decoration.
    //
    // The guarantee actually lives in two places, both already covered:
    // `booking-exclusion.test.ts` asserts booking_no_overlap exists in the
    // live schema, and `migration-safety` fails any migration that drops it.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, `burst-${i}`),
      ),
    );

    const created = attempts.filter((a) => a.res.status === 201);
    const conflicted = attempts.filter((a) => a.res.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);
  });

  it.each([
    ['before opening', '2026-07-15T05:00:00Z', '2026-07-15T06:00:00Z'],
    ['past closing', '2026-07-15T13:00:00Z', '2026-07-15T15:00:00Z'],
    ['not a whole unit', NINE_AM, '2026-07-15T06:30:00Z'],
  ])('rejects a booking %s', async (_label, startTs, endTs) => {
    const { res, body } = await create(player, { resourceId, startTs, endTs });

    expect(res.status).toBe(400);
    expect((body as ApiError).error.code).toBe('SLOT_NOT_BOOKABLE');
  });

  it('401s without a token', async () => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'x' },
        body: JSON.stringify({ resourceId, startTs: NINE_AM, endTs: TEN_AM }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );

    expect(res.status).toBe(401);
  });

  describe('listing and cancelling', () => {
    const list = async (who: TestIdentity) => {
      const res = await listRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug }) },
      );
      return (await res.json()) as { data: { items: Array<{ id: string }> } };
    };

    const cancel = async (who: TestIdentity, bookingId: string) => {
      const res = await cancelRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${bookingId}/cancel`, {
          method: 'POST',
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug, id: bookingId }) },
      );
      return { res, body: (await res.json()) as never };
    };

    it('lists only the caller’s own bookings', async () => {
      const mine = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const theirs = await create(owner, {
        resourceId,
        startTs: '2026-07-15T08:00:00Z',
        endTs: '2026-07-15T09:00:00Z',
      });

      const playerList = await list(player);
      const ids = playerList.data.items.map((b) => b.id);

      expect(ids).toContain((mine.body as Created).data.id);
      expect(ids).not.toContain((theirs.body as Created).data.id);
    });

    it('cancels own booking and quotes the refund', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;

      const { res, body: cancelled } = await cancel(player, id);

      expect(res.status).toBe(200);
      expect(
        (cancelled as { data: { bookingId: string; refundPercent: number } }).data.bookingId,
      ).toBe(id);
    });

    it('404s — not 403 — when cancelling somebody else’s booking', async () => {
      // A PLAYER holds bookings.cancel, so the middleware lets them through.
      // Ownership is a row-level question and only this route can answer it.
      // 403 would confirm the booking exists, which enumerates the club's
      // reservations one id at a time.
      const { body } = await create(owner, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const someoneElses = (body as Created).data.id;

      const { res } = await cancel(player, someoneElses);

      expect(res.status).toBe(404);
    });

    it('409s on a second cancellation instead of writing a second receipt', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;

      await cancel(player, id);
      const { res } = await cancel(player, id);

      expect(res.status).toBe(409);
    });

    it('frees the slot once cancelled', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      await cancel(player, (body as Created).data.id);

      const again = await create(owner, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

      expect(again.res.status).toBe(201);
    });
  });
});
