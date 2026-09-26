import { DIARY_STATUSES, listDayBookings } from '@/app-layer/repositories/diary';
import { createCourt } from '@/app-layer/usecases/courts';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * ONE DAY'S BOOKINGS, ACROSS EVERY COURT.
 *
 * The day window is unit-tested separately against both DST boundaries. What
 * needs a database is the QUERY: which bookings a given local day pulls in, and
 * which it must not.
 *
 * Two of these are the kind of wrong that does not raise — a diary that omits
 * a booking tells a staff member a court is free, and they double-book it by
 * hand at the front desk.
 */

const COURT = {
  name: 'Court 1',
  sport: 'PADEL',
  resourceType: 'COURT',
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 4,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
} as const;

describe('listDayBookings', () => {
  const db = prismaTestClient();
  let seq = 0;

  async function club(tag: string, timezone = 'Europe/Sofia') {
    const t = await seedTenant({}, db);
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: t.tenantId }, data: { timezone } }),
    );
    const venue = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: t.tenantId,
          name: `Site ${tag}`,
          slug: `site-${tag}-${t.tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `s-${tag}-${t.tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...COURT, venueId: venue.id }),
    );
    return { ...t, courtId: court.id, timezone };
  }

  /** A booking at absolute times, so the window arithmetic is what is tested. */
  async function booking(
    tenantId: string,
    resourceId: string,
    startIso: string,
    endIso: string,
    status: string = 'CONFIRMED',
  ) {
    seq += 1;
    return asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId,
          resourceId,
          startTs: new Date(startIso),
          endTs: new Date(endIso),
          status: status as never,
          totalCents: 2400,
          guestName: `Guest ${seq}`,
          guestEmail: `g${seq}@test.invalid`,
          idempotencyKey: `diary-${seq}-${resourceId.slice(-6)}`,
        },
        select: { id: true },
      }),
    );
  }

  const day = (t: { tenantId: string; timezone: string }, isoDay: string) =>
    runInTenantContext(t.tenantId, (c) =>
      listDayBookings(c, t.tenantId, { isoDay, timezone: t.timezone }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    seq = 0;
  });

  it('THE POINT: returns the club’s local day, not a UTC day', async () => {
    // Sofia is UTC+2 in January. A booking at 00:30 LOCAL on the 15th is
    // 22:30 UTC on the 14th — a UTC-day query would put it on the wrong day.
    const c = await club('a');
    await booking(c.tenantId, c.courtId, '2026-01-14T22:30:00Z', '2026-01-14T23:30:00Z');

    expect(await day(c, '2026-01-15')).toHaveLength(1);
    expect(await day(c, '2026-01-14')).toHaveLength(0);
  });

  it('includes a booking that OVERLAPS the day, not only one contained in it', async () => {
    // 23:00–00:30 local belongs on both diaries: a staff member looking at
    // either needs to see the court is occupied. Containment would drop it
    // from one of them and the court would read free.
    const c = await club('b');
    // 23:00 local on the 15th = 21:00Z; ends 00:30 local on the 16th = 22:30Z.
    await booking(c.tenantId, c.courtId, '2026-01-15T21:00:00Z', '2026-01-15T22:30:00Z');

    expect(await day(c, '2026-01-15')).toHaveLength(1);
    expect(await day(c, '2026-01-16')).toHaveLength(1);
  });

  it('includes PENDING, because a pending booking HOLDS the slot', async () => {
    // expiresAt is what releases it. A diary showing only CONFIRMED would say
    // a court is free while somebody is mid-checkout on it.
    const c = await club('c');
    await booking(c.tenantId, c.courtId, '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', 'PENDING');

    const rows = await day(c, '2026-01-15');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it.each(['CANCELLED', 'NO_SHOW'])('excludes %s — the slot is free again', async (status) => {
    const c = await club(`d-${status}`);
    await booking(c.tenantId, c.courtId, '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', status);

    expect(await day(c, '2026-01-15')).toHaveLength(0);
  });

  it('never returns another club’s bookings', async () => {
    const mine = await club('mine');
    const theirs = await club('theirs');
    await booking(mine.tenantId, mine.courtId, '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z');
    await booking(theirs.tenantId, theirs.courtId, '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z');

    const rows = await day(mine, '2026-01-15');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceId).toBe(mine.courtId);
  });

  it('SPRING FORWARD: picks up the whole 23-hour day and nothing beyond it', async () => {
    // 29 March 2026, Sofia: 03:00 → 04:00. The local day runs 22:00Z on the
    // 28th to 21:00Z on the 29th. A `from + 24h` window would reach an hour
    // into the 30th.
    const c = await club('spring');
    // 22:30 local on the 29th = 19:30Z — inside.
    await booking(c.tenantId, c.courtId, '2026-03-29T19:30:00Z', '2026-03-29T20:30:00Z');
    // 00:30 local on the 30th = 21:30Z on the 29th — the hour a naive window
    // would wrongly include.
    await booking(c.tenantId, c.courtId, '2026-03-29T21:30:00Z', '2026-03-29T22:30:00Z');

    const rows = await day(c, '2026-03-29');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startTs.toISOString()).toBe('2026-03-29T19:30:00.000Z');
  });

  it('FALL BACK: picks up the last hour of a 25-hour day', async () => {
    // 25 October 2026, Sofia: 04:00 → 03:00. The local day runs 21:00Z on the
    // 24th to 22:00Z on the 25th. A `from + 24h` window would stop at 21:00Z
    // and silently omit this booking — a court that reads free and is not.
    const c = await club('fall');
    await booking(c.tenantId, c.courtId, '2026-10-25T21:15:00Z', '2026-10-25T21:45:00Z');

    expect(await day(c, '2026-10-25')).toHaveLength(1);
  });

  it('reads the club’s zone, so the same instant lands on different days elsewhere', async () => {
    // A club in London and a club in Sofia, one absolute instant: 22:30Z on
    // 14 January is 00:30 on the 15th in Sofia and 22:30 on the 14th in London.
    const sofia = await club('sofia', 'Europe/Sofia');
    const london = await club('london', 'Europe/London');
    await booking(sofia.tenantId, sofia.courtId, '2026-01-14T22:30:00Z', '2026-01-14T23:30:00Z');
    await booking(london.tenantId, london.courtId, '2026-01-14T22:30:00Z', '2026-01-14T23:30:00Z');

    expect(await day(sofia, '2026-01-15')).toHaveLength(1);
    expect(await day(london, '2026-01-14')).toHaveLength(1);
    expect(await day(london, '2026-01-15')).toHaveLength(0);
  });

  it('the status set matches what the booking path treats as occupying a slot', async () => {
    // Stated rather than assumed: if the booking path ever adds a holding
    // status, this list has to follow or the diary understates occupancy.
    expect([...DIARY_STATUSES].sort()).toEqual(['COMPLETED', 'CONFIRMED', 'PENDING']);
  });
});
