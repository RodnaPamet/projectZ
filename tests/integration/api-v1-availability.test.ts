import { NextRequest } from 'next/server';

import { GET as getAvailability } from '@/app/api/v1/venues/[id]/availability/route';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Availability, against a real database.
 *
 * The slot engine has unit tests and they pass on hand-built inputs. What they
 * cannot cover is the shape the DATABASE returns: `openTime` is a `time`
 * column, and Prisma hands it back as a Date pinned to 1970-01-01 UTC. Read it
 * with the local accessors and every slot shifts by the server's own offset —
 * an hour out on this repo's machine, and exactly right on a UTC CI runner,
 * which is the failure mode that survives review.
 *
 * So these run the HANDLER over real rows.
 */
describe('GET /api/v1/venues/:id/availability', () => {
  const db = prismaTestClient();
  let tenant: SeededTenant;
  let venueId: string;
  let resourceId: string;

  // 2026-07-15 is a Wednesday. Sofia is UTC+3 in July, so 09:00 local = 06:00Z.
  const WEDNESDAY = '2026-07-15';

  beforeEach(async () => {
    tenant = await seedTenant({}, db);

    const seeded = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `slot-club-${Date.now()}`,
          name: 'Slot Club',
          description: 'Opens at nine',
          addressLine: '9 Court St',
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
          slotStepMinutes: 60,
        },
      });

      await tx.resourceAvailability.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId: resource.id,
          dayOfWeek: 3, // Wednesday
          // A `time` column. The DATE part is ignored by Postgres.
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      });

      return { venue, resource };
    });

    venueId = seeded.venue.id;
    resourceId = seeded.resource.id;
  });

  const call = async (query: string) => {
    const res = await getAvailability(
      new NextRequest(`http://t/api/v1/venues/${venueId}/availability${query}`),
      { params: Promise.resolve({ id: venueId }) },
    );
    return { res, body: (await res.json()) as never };
  };

  type Body = {
    data: {
      timezone: string;
      from: string;
      to: string;
      resources: Array<{
        resourceId: string;
        slots: Array<{ startTs: string; endTs: string; priceCents: number; available: boolean }>;
      }>;
    };
  };

  it('reads the time column through UTC — 09:00 local is 06:00Z, not 07:00Z', async () => {
    // THE test. `getHours()` on a 1970-01-01 Date applies the SERVER's offset:
    // on a UTC+1 host 09:00 would come back as 10:00 and every player would be
    // told the wrong hour. Asserting the absolute instants pins it.
    const { res, body } = await call(`?date=${WEDNESDAY}`);
    const data = (body as Body).data;

    expect(res.status).toBe(200);
    expect(data.resources).toHaveLength(1);

    expect(data.resources[0]!.slots.map((s) => s.startTs)).toEqual([
      '2026-07-15T06:00:00Z',
      '2026-07-15T07:00:00Z',
      '2026-07-15T08:00:00Z',
    ]);
  });

  it('emits timestamps a Swift .iso8601 decoder accepts', async () => {
    // `toISOString()` appends `.000`, which ISO8601DateFormatter rejects unless
    // .withFractionalSeconds is set — and the default strategy does not set it.
    // The failure lands at the decoder and names the whole response.
    const { body } = await call(`?date=${WEDNESDAY}`);
    const data = (body as Body).data;

    const stamps = [
      data.from,
      data.to,
      ...data.resources[0]!.slots.flatMap((s) => [s.startTs, s.endTs]),
    ];

    for (const s of stamps) {
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it('interprets ?date in the VENUE timezone, not UTC', async () => {
    // Sofia midnight is 21:00Z the previous day. If the range were resolved in
    // UTC the window would be shifted three hours and the last slot would fall
    // outside it.
    const { body } = await call(`?date=${WEDNESDAY}`);
    const data = (body as Body).data;

    expect(data.timezone).toBe('Europe/Sofia');
    expect(data.from).toBe('2026-07-14T21:00:00Z');
    expect(data.to).toBe('2026-07-15T21:00:00Z');
  });

  it('a PENDING booking holds its slot, exactly as the exclusion constraint does', async () => {
    // booking_no_overlap is WHERE status IN ('CONFIRMED','PENDING'). If this
    // route disagreed, it would offer a slot whose INSERT the database rejects
    // — which reaches the player as a random failure at checkout.
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date('2026-07-15T07:00:00Z'), // 10:00 Sofia
          endTs: new Date('2026-07-15T08:00:00Z'),
          status: 'PENDING',
          totalCents: 2400,
          idempotencyKey: `pending-${Date.now()}`,
        },
      }),
    );

    const { body } = await call(`?date=${WEDNESDAY}`);
    const slots = (body as Body).data.resources[0]!.slots;

    expect(slots.find((s) => s.startTs === '2026-07-15T07:00:00Z')!.available).toBe(false);
    expect(slots.find((s) => s.startTs === '2026-07-15T06:00:00Z')!.available).toBe(true);
  });

  it('a CANCELLED booking frees its slot', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date('2026-07-15T07:00:00Z'),
          endTs: new Date('2026-07-15T08:00:00Z'),
          status: 'CANCELLED',
          totalCents: 2400,
          idempotencyKey: `cancelled-${Date.now()}`,
        },
      }),
    );

    const { body } = await call(`?date=${WEDNESDAY}`);
    const slots = (body as Body).data.resources[0]!.slots;

    expect(slots.every((s) => s.available)).toBe(true);
  });

  it('never names who holds a slot', async () => {
    // The booking query selects three columns on purpose. A public read that
    // leaked bookedByUserId would be a privacy incident, not a bug.
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date('2026-07-15T07:00:00Z'),
          endTs: new Date('2026-07-15T08:00:00Z'),
          status: 'CONFIRMED',
          totalCents: 2400,
          guestEmail: 'someone@private.test',
          guestName: 'Private Person',
          idempotencyKey: `named-${Date.now()}`,
        },
      }),
    );

    const { body } = await call(`?date=${WEDNESDAY}`);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('someone@private.test');
    expect(raw).not.toContain('Private Person');
    expect(raw).not.toContain('bookedByUserId');
  });

  it('works with no tenant bound — the public binding is the point', async () => {
    // `court_availability`, `court` and `booking` all have FORCE RLS keyed on
    // app.tenant_id. Bound as app_user with no tenant this returns zero rows
    // and looks exactly like "the club has no free courts".
    const { res, body } = await call(`?date=${WEDNESDAY}`);

    expect(res.status).toBe(200);
    expect((body as Body).data.resources[0]!.slots.length).toBeGreaterThan(0);
  });

  it('404s for a venue that does not exist', async () => {
    const res = await getAvailability(new NextRequest('http://t/api/v1/venues/nope/availability'), {
      params: Promise.resolve({ id: 'nope' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects a range wider than the engine will materialise', async () => {
    const { res, body } = await call('?from=2026-07-15T00:00:00Z&to=2026-12-15T00:00:00Z');

    expect(res.status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('RANGE_TOO_WIDE');
  });

  it('rejects a malformed date rather than guessing', async () => {
    const { res } = await call('?date=15-07-2026');
    expect(res.status).toBe(400);
  });
});
