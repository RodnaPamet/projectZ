import { listMyBookings } from '@/app-layer/usecases/my-bookings';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * "MY BOOKINGS" SPANS CLUBS, AND A LIST THAT DOES NOT IS WRONG INVISIBLY.
 *
 * A player books padel at one club and tennis at another. If the page shows
 * only one of them, the missing booking looks like a booking that FAILED —
 * they rebook, pay twice, and turn up to an empty court at the other club.
 *
 * This needs a real database because the thing being tested is an RLS binding.
 * `booking` carries `tenantId = app.tenant_id` and nothing else, so the wrong
 * binding here does not raise — it returns zero rows, and an empty list reads
 * as "you have no bookings". The only way to tell the two apart is to seed two
 * tenants and count.
 */
describe('listMyBookings', () => {
  const db = prismaTestClient();

  let clubA: SeededTenant;
  let clubB: SeededTenant;
  let playerId: string;
  let strangerId: string;

  const bookingAt = async (tenantId: string, venueName: string, startTs: string, userId: string) =>
    asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId,
          slug: `v-${Math.random().toString(36).slice(2, 10)}`,
          name: venueName,
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'v@club.test',
          lat: 42.6977,
          lng: 23.3219,
          timezone: 'Europe/Sofia',
        },
      });
      const resource = await tx.resource.create({
        data: {
          tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'TENNIS',
          surface: 'CLAY',
          basePriceCents: 2400,
        },
      });
      return tx.booking.create({
        data: {
          tenantId,
          resourceId: resource.id,
          startTs: new Date(startTs),
          endTs: new Date(new Date(startTs).getTime() + 3_600_000),
          bookedByUserId: userId,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      });
    });

  beforeEach(async () => {
    clubA = await seedTenant({});
    clubB = await seedTenant({});
    playerId = await seedPlayer(db, clubA.tenantId);
    strangerId = await seedPlayer(db, clubA.tenantId, 'stranger');
  });

  it('returns bookings from EVERY club, not just one', async () => {
    await bookingAt(clubA.tenantId, 'Club A', '2026-07-15T06:00:00Z', playerId);
    await bookingAt(clubB.tenantId, 'Club B', '2026-07-16T06:00:00Z', playerId);

    const { items } = await listMyBookings({ userId: playerId });

    expect(items).toHaveLength(2);
    expect(items.map((b) => b!.resource.venue.name).sort()).toEqual(['Club A', 'Club B']);
    // Two DIFFERENT tenants, which is the whole assertion — one bound query
    // could only ever have returned one of these.
    expect(new Set(items.map((b) => b!.tenantId)).size).toBe(2);
  });

  it('newest first, across clubs', async () => {
    await bookingAt(clubA.tenantId, 'Older', '2026-07-15T06:00:00Z', playerId);
    await bookingAt(clubB.tenantId, 'Newer', '2026-08-20T06:00:00Z', playerId);

    const { items } = await listMyBookings({ userId: playerId });

    expect(items.map((b) => b!.resource.venue.name)).toEqual(['Newer', 'Older']);
  });

  it("returns NOBODY ELSE's bookings, even at a club they share", async () => {
    // The scope is bookedByUserId. Binding superuser removes the tenant fence,
    // so this WHERE clause is the only thing left — it has to be right.
    await bookingAt(clubA.tenantId, 'Mine', '2026-07-15T06:00:00Z', playerId);
    await bookingAt(clubA.tenantId, 'Theirs', '2026-07-15T08:00:00Z', strangerId);

    const { items } = await listMyBookings({ userId: playerId });

    expect(items).toHaveLength(1);
    expect(items[0]!.resource.venue.name).toBe('Mine');
  });

  it('is empty for somebody who has booked nothing', async () => {
    const { items, nextCursor } = await listMyBookings({ userId: strangerId });

    expect(items).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it('paginates by keyset, and the cursor does not repeat a row', async () => {
    await bookingAt(clubA.tenantId, 'One', '2026-07-15T06:00:00Z', playerId);
    await bookingAt(clubB.tenantId, 'Two', '2026-07-16T06:00:00Z', playerId);
    await bookingAt(clubA.tenantId, 'Three', '2026-07-17T06:00:00Z', playerId);

    const first = await listMyBookings({ userId: playerId, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listMyBookings({ userId: playerId, limit: 2, cursor: first.nextCursor });

    const ids = [...first.items, ...second.items].map((b) => b!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });
});
