import { NextRequest } from 'next/server';

import { createBooking } from '@/app-layer/usecases/booking';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { POST as createRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE CLUB'S CAP ON A PLAYER'S UPCOMING ONLINE BOOKINGS (#380), through the
 * real route against a real database.
 *
 * The case that matters most is the burst: the cap is a COUNT followed by an
 * INSERT, which no constraint can arbitrate, so it is held by an advisory lock
 * on (club, player). Without that lock the burst test below lets a player past
 * the cap — checked by removing it, not assumed.
 */

const HOUR = 3_600_000;

// 2036-07-16 is a Wednesday. Sofia is UTC+3 in July: the club is open
// 09:00–17:00 local, 06:00Z–14:00Z, one-hour steps.
const slot = (hourUtc: number) => ({
  startTs: `2036-07-16T${String(hourUtc).padStart(2, '0')}:00:00Z`,
  endTs: `2036-07-16T${String(hourUtc + 1).padStart(2, '0')}:00:00Z`,
});

describe('the cap on upcoming online bookings (#380)', () => {
  const db = prismaTestClient();

  let club: SeededTenant;
  let player: TestIdentity;
  let resourceId: string;

  /** A club with one venue and one court open Wednesdays 09:00–17:00 Sofia. */
  async function seedClub(): Promise<{ tenant: SeededTenant; resourceId: string }> {
    const tenant = await seedTenant({}, db);
    const resource = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `cap-${tenant.tenantId.slice(-8)}`,
          name: 'Cap Club',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          lat: 42.6977,
          lng: 23.3219,
          timezone: 'Europe/Sofia',
        },
      });
      const r = await tx.resource.create({
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
          resourceId: r.id,
          dayOfWeek: 3,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T17:00:00Z'),
        },
      });
      return r;
    });
    return { tenant, resourceId: resource.id };
  }

  beforeEach(async () => {
    await resetDatabase(db);
    ({ tenant: club, resourceId } = await seedClub());
    const playerId = await seedPlayer(db, club.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  const book = async (
    hourUtc: number,
    opts: { key?: string; who?: TestIdentity; slug?: string; resource?: string } = {},
  ) => {
    const slug = opts.slug ?? club.tenantSlug;
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${slug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${(opts.who ?? player).bearer}`,
          'content-type': 'application/json',
          'idempotency-key': opts.key ?? `key-${Math.random()}`,
        },
        body: JSON.stringify({ resourceId: opts.resource ?? resourceId, ...slot(hourUtc) }),
      }),
      { params: Promise.resolve({ slug }) },
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        data?: { id: string };
        error?: { code: string; message: string; details?: Record<string, unknown> };
      },
    };
  };

  const setCap = (limit: number) =>
    asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: club.tenantId },
        data: { maxUpcomingOnlineBookings: limit },
      }),
    );

  const heldOnline = () =>
    asAppSuperuser(db, (tx) =>
      tx.booking.count({
        where: {
          tenantId: club.tenantId,
          bookedByUserId: player.userId,
          channel: 'ONLINE',
          status: 'CONFIRMED',
        },
      }),
    );

  it('defaults to 3, and the 4th is 409 BOOKING_LIMIT_REACHED with the numbers, in the player’s language', async () => {
    const org = await asAppSuperuser(db, (tx) =>
      tx.venueOrg.findUniqueOrThrow({ where: { id: club.tenantId } }),
    );
    expect(org.maxUpcomingOnlineBookings).toBe(3);

    for (const h of [6, 7, 8]) expect((await book(h)).status).toBe(201);

    const refused = await book(9);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'BOOKING_LIMIT_REACHED',
      details: { limit: 3, upcoming: 3 },
    });
    // `User.locale` defaults to bg.
    expect(refused.body.error!.message).toContain('лимита');
    expect(await heldOnline()).toBe(3);
  });

  it('records the channel: a booking made through the route is ONLINE', async () => {
    const { body } = await book(6);
    const row = await asAppSuperuser(db, (tx) =>
      tx.booking.findUniqueOrThrow({ where: { id: body.data!.id } }),
    );
    expect(row.channel).toBe('ONLINE');
  });

  it('is the CLUB’s setting', async () => {
    await setCap(1);
    expect((await book(6)).status).toBe(201);

    const refused = await book(7);
    expect(refused.status).toBe(409);
    expect(refused.body.error!.details).toEqual({ limit: 1, upcoming: 1 });
  });

  it('desk bookings neither count toward it nor are limited by it', async () => {
    await setCap(1);
    const desk = (hourUtc: number) =>
      runInTenantContext(club.tenantId, (tx) =>
        createBooking(tx, club.tenantId, {
          resourceId,
          startTs: new Date(slot(hourUtc).startTs),
          endTs: new Date(slot(hourUtc).endTs),
          totalCents: 2400,
          idempotencyKey: `desk-${hourUtc}`,
          bookedByUserId: player.userId,
          channel: 'DESK',
        }),
      );

    // Two desk bookings for the player: not counted…
    await desk(10);
    await desk(11);
    expect((await book(6)).status).toBe(201);

    // …and with the player AT the online cap, the desk still books for them.
    expect((await book(7)).status).toBe(409);
    const third = await desk(12);
    expect(third.idempotentReplay).toBe(false);

    const rows = await asAppSuperuser(db, (tx) =>
      tx.booking.findMany({
        where: { bookedByUserId: player.userId, status: 'CONFIRMED' },
        select: { channel: true },
        take: 10,
      }),
    );
    expect(rows.filter((r) => r.channel === 'DESK')).toHaveLength(3);
    expect(rows.filter((r) => r.channel === 'ONLINE')).toHaveLength(1);
  });

  it('cancelling one frees a place', async () => {
    const made: Awaited<ReturnType<typeof book>>[] = [];
    for (const h of [6, 7, 8]) made.push(await book(h));
    expect((await book(9)).status).toBe(409);

    const id = made[0]!.body.data!.id;
    const cancelled = await cancelRoute(
      new NextRequest(`http://t/api/v1/t/${club.tenantSlug}/bookings/${id}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${player.bearer}` },
      }),
      { params: Promise.resolve({ slug: club.tenantSlug, id }) },
    );
    expect(cancelled.status).toBe(200);

    expect((await book(9)).status).toBe(201);
    expect((await book(10)).status).toBe(409);
  });

  it('past bookings, and one under way, do not count', async () => {
    const made: Awaited<ReturnType<typeof book>>[] = [];
    for (const h of [6, 7, 8]) made.push(await book(h));

    // One moved into the past (played), one to have started ten minutes ago.
    const now = Date.now();
    await asAppSuperuser(db, async (tx) => {
      await tx.booking.update({
        where: { id: made[0]!.body.data!.id },
        data: { startTs: new Date(now - 26 * HOUR), endTs: new Date(now - 25 * HOUR) },
      });
      await tx.booking.update({
        where: { id: made[1]!.body.data!.id },
        data: { startTs: new Date(now - HOUR / 6), endTs: new Date(now + (5 * HOUR) / 6) },
      });
    });

    expect((await book(9)).status).toBe(201);
    expect((await book(10)).status).toBe(201);
    const refused = await book(11);
    expect(refused.status).toBe(409);
    expect(refused.body.error!.details).toEqual({ limit: 3, upcoming: 3 });
  });

  it('bookings at OTHER clubs do not count, and are capped by their own club', async () => {
    const other = await seedClub();
    for (const h of [6, 7, 8]) {
      expect(
        (await book(h, { slug: other.tenant.tenantSlug, resource: other.resourceId })).status,
      ).toBe(201);
    }

    for (const h of [6, 7, 8]) expect((await book(h)).status).toBe(201);
    expect((await book(9)).status).toBe(409);
    expect(
      (await book(9, { slug: other.tenant.tenantSlug, resource: other.resourceId })).status,
    ).toBe(409);
  });

  it('another player’s bookings do not count toward this player’s cap', async () => {
    const rivalId = await seedPlayer(db, club.tenantId, 'rival');
    const rival = await signInAs(db, {
      userId: rivalId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
    for (const h of [6, 7, 8]) expect((await book(h, { who: rival })).status).toBe(201);

    expect((await book(9)).status).toBe(201);
  });

  it('an idempotent REPLAY at the cap returns the booking it made', async () => {
    await book(6);
    await book(7);
    const third = await book(8, { key: 'third-tap' });
    expect(third.status).toBe(201);

    const retry = await book(8, { key: 'third-tap' });
    expect(retry.status).toBe(200);
    expect(retry.body.data!.id).toBe(third.body.data!.id);

    // …while a NEW booking is refused.
    expect((await book(9)).status).toBe(409);
  });

  it('a burst of parallel retries of ONE tap creates one booking and returns it to every retry', async () => {
    await book(6);
    await book(7);

    // At 2 of 3. Without the replay re-check under the lock, the retries that
    // waited for the first would count its row and answer 409 to the player
    // about the booking they just made.
    const retries = await Promise.all(Array.from({ length: 6 }, () => book(8, { key: 'one-tap' })));

    const ids = new Set(retries.map((r) => r.body.data?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeDefined();
    expect(retries.filter((r) => r.status === 201)).toHaveLength(1);
    expect(retries.filter((r) => r.status === 200)).toHaveLength(5);
    expect(await heldOnline()).toBe(3);
  });

  it('THE POINT: a burst of parallel online bookings stays at the cap', async () => {
    // Eight different free slots, eight different keys, all at once. Each
    // request alone is valid; together they must yield exactly three.
    const N = 8;
    const attempts = await Promise.all(Array.from({ length: N }, (_, i) => book(6 + i)));

    const created = attempts.filter((a) => a.status === 201);
    const refused = attempts.filter((a) => a.status === 409);

    expect(created).toHaveLength(3);
    expect(refused).toHaveLength(N - 3);
    for (const r of refused) {
      expect(r.body.error).toMatchObject({
        code: 'BOOKING_LIMIT_REACHED',
        details: { limit: 3, upcoming: 3 },
      });
    }
    expect(await heldOnline()).toBe(3);
  });

  it('the burst holds per player: two players bursting at once each get their own cap', async () => {
    const rivalId = await seedPlayer(db, club.tenantId, 'rival');
    const rival = await signInAs(db, {
      userId: rivalId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
    await setCap(2);

    // Player takes 06–09Z, rival 10–13Z: no slot clashes, only the cap decides.
    const attempts = await Promise.all([
      ...[6, 7, 8, 9].map((h) => book(h)),
      ...[10, 11, 12, 13].map((h) => book(h, { who: rival })),
    ]);

    expect(attempts.slice(0, 4).filter((a) => a.status === 201)).toHaveLength(2);
    expect(attempts.slice(4).filter((a) => a.status === 201)).toHaveLength(2);
  });
});
