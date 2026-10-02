import { formatInTimeZone } from 'date-fns-tz';

import { loadDiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { createCourt } from '@/app-layer/usecases/courts';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * WHAT THE DIARY DRAWS FOR ONE DAY, BUILT ONCE FOR TWO CALLERS (#314).
 *
 * The page renders `loadDiaryDay`, and the grid's stale-data refresh
 * (`refreshDiaryDayAction`) hands the same object back to a grid that has
 * been on screen too long. If the two built a day differently, a refresh
 * would redraw the diary as something the page never showed. So the builder
 * is one function, and this proves it against a real database: the club's
 * wall clock, the URL's day, the names, and a `renderedAt` that moves on.
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

const LABELS = { unknownPlayer: 'Непознат играч', guest: 'Гост' };
const OPTS = { locale: 'bg', labels: LABELS };

describe('loadDiaryDay', () => {
  const db = prismaTestClient();

  async function club() {
    const t = await seedTenant({}, db);
    const venue = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: t.tenantId,
          name: 'Site',
          slug: `site-${t.tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `s-${t.tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...COURT, venueId: venue.id }),
    );
    return { ...t, courtId: court.id };
  }

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: builds the requested day on the club’s wall clock, with its neighbours', async () => {
    const c = await club();
    // 10:00–11:30 in Sofia on 15 January (UTC+2).
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: c.tenantId,
          resourceId: c.courtId,
          startTs: new Date('2026-01-15T08:00:00Z'),
          endTs: new Date('2026-01-15T09:30:00Z'),
          status: 'CONFIRMED',
          totalCents: 3600,
          guestName: 'Мария',
          guestEmail: 'maria@test.invalid',
          idempotencyKey: `diary-day-${c.courtId.slice(-6)}`,
        },
      }),
    );

    const day = await loadDiaryDay(c.tenantId, '2026-01-15', OPTS);

    expect(day).toMatchObject({
      isoDay: '2026-01-15',
      prevDay: '2026-01-14',
      nextDay: '2026-01-16',
      isToday: false,
      courts: [{ id: c.courtId, name: 'Court 1', venueName: null }],
      firstHour: 8,
      lastHour: 22,
    });
    expect(day.bookings).toHaveLength(1);
    expect(day.bookings[0]).toMatchObject({
      startLabel: '10:00',
      endLabel: '11:30',
      // Offset from the grid's first hour (08:00), not from midnight.
      startOffsetMinutes: 120,
      durationMinutes: 90,
      who: 'Мария',
      status: 'CONFIRMED',
      canMarkNoShow: true,
    });
    expect(day.bookings[0]!.priceLabel).toMatch(/36,00/);
  });

  it('anything but an ISO day (or none) is the club’s today', async () => {
    const c = await club();
    const today = formatInTimeZone(new Date(), 'Europe/Sofia', 'yyyy-MM-dd');

    for (const requested of [null, undefined, 'tomorrow', '2026-1-5']) {
      const day = await loadDiaryDay(c.tenantId, requested, OPTS);
      expect({ requested, isoDay: day.isoDay, isToday: day.isToday }).toEqual({
        requested,
        isoDay: today,
        isToday: true,
      });
    }
  });

  it('stamps each build with when it was built, so the grid can tell a newer copy', async () => {
    const c = await club();
    const before = Date.now();
    const first = await loadDiaryDay(c.tenantId, '2026-01-15', OPTS);
    await new Promise((r) => setTimeout(r, 5));
    const second = await loadDiaryDay(c.tenantId, '2026-01-15', OPTS);

    expect(first.renderedAt).toBeGreaterThanOrEqual(before);
    expect(second.renderedAt).toBeGreaterThan(first.renderedAt);
  });

  it('is plain data, so it crosses the server-action boundary as it is', async () => {
    const c = await club();
    const day = await loadDiaryDay(c.tenantId, '2026-01-15', OPTS);
    expect(JSON.parse(JSON.stringify(day))).toEqual(day);
  });
});
