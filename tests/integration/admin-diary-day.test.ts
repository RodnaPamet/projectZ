import { formatInTimeZone } from 'date-fns-tz';

import { loadDiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { createCourt } from '@/app-layer/usecases/courts';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { confirmPhoneFor } from '../helpers/phone';
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

const LABELS = { unknownPlayer: 'Непознат играч', guest: 'Гост', deletedUser: 'Изтрит потребител' };
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

  describe('the booker’s confirmed number (#500): for an upcoming online booking, and nowhere else', () => {
    const HOUR = 3_600_000;
    const PHONE = '+359888123456';

    async function player(c: { tenantId: string }, phone: string | null) {
      const userId = await seedPlayer(
        db,
        c.tenantId,
        `diary-${Math.random().toString(36).slice(2, 7)}`,
      );
      if (phone) await confirmPhoneFor(db, userId, phone);
      return userId;
    }

    /** A booking starting `fromNowHours` from now, an hour long. */
    const book = (
      c: { tenantId: string; courtId: string },
      fromNowHours: number,
      data: Record<string, unknown>,
    ) =>
      asAppSuperuser(db, (tx) =>
        tx.booking.create({
          data: {
            tenantId: c.tenantId,
            resourceId: c.courtId,
            startTs: new Date(Date.now() + fromNowHours * HOUR),
            endTs: new Date(Date.now() + (fromNowHours + 1) * HOUR),
            status: 'CONFIRMED',
            totalCents: 2400,
            idempotencyKey: `diary-phone-${Math.random()}`,
            ...data,
          } as never,
          select: { id: true, startTs: true },
        }),
      );

    /** The diary of the club's day that holds `at`, and the booking in it. */
    async function inDiary(c: { tenantId: string }, b: { id: string; startTs: Date }) {
      const isoDay = formatInTimeZone(b.startTs, 'Europe/Sofia', 'yyyy-MM-dd');
      const day = await loadDiaryDay(c.tenantId, isoDay, OPTS);
      return day.bookings.find((x) => x.id === b.id)!;
    }

    it('an upcoming online booking shows the number its booker confirmed', async () => {
      const c = await club();
      const booker = await player(c, PHONE);
      const b = await book(c, 3, { bookedByUserId: booker });
      expect((await inDiary(c, b)).bookerPhone).toBe(PHONE);
    });

    it('a booker with no confirmed number shows none', async () => {
      const c = await club();
      const b = await book(c, 3, { bookedByUserId: await player(c, null) });
      expect((await inDiary(c, b)).bookerPhone).toBeNull();
    });

    it('a booking that is over, or cancelled, shows none: the club has no call to make', async () => {
      const c = await club();
      const booker = await player(c, PHONE);
      const past = await book(c, -3, { bookedByUserId: booker, status: 'COMPLETED' });
      const ended = await book(c, -2, { bookedByUserId: booker }); // CONFIRMED, already over
      const cancelled = await book(c, 5, { bookedByUserId: booker, status: 'CANCELLED' });
      expect((await inDiary(c, past)).bookerPhone).toBeNull();
      expect((await inDiary(c, ended)).bookerPhone).toBeNull();
      // A cancelled booking may not be listed at all; if it is, it has no number.
      expect((await inDiary(c, cancelled))?.bookerPhone ?? null).toBeNull();
    });

    it('a booking in progress still shows it', async () => {
      const c = await club();
      const b = await book(c, -0.5, { bookedByUserId: await player(c, PHONE) });
      expect((await inDiary(c, b)).bookerPhone).toBe(PHONE);
    });

    it('a desk booking linked to the player shows none: the desk has the number it typed', async () => {
      const c = await club();
      const b = await book(c, 3, {
        bookedByUserId: await player(c, PHONE),
        channel: 'DESK',
        guestName: 'Иван',
        guestPhone: '+359877000111',
      });
      const row = await inDiary(c, b);
      expect(row.desk).toBe(true);
      expect(row.bookerPhone).toBeNull();
    });

    it('the other players on a booking are named, and their numbers are not shown', async () => {
      const c = await club();
      const booker = await player(c, PHONE);
      const friend = await player(c, '+359888999000');
      const b = await book(c, 3, { bookedByUserId: booker });
      await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.create({
          data: { tenantId: c.tenantId, bookingId: b.id, userId: friend, position: 1 },
        }),
      );
      const row = await inDiary(c, b);
      expect(row.players).toHaveLength(1);
      expect(JSON.stringify(row)).not.toContain('888999000');
      expect(row.bookerPhone).toBe(PHONE);
    });

    it('another club’s diary never has it: the number goes with the booking, not the player', async () => {
      const [here, there] = [await club(), await club()];
      const booker = await player(here, PHONE);
      await book(here, 3, { bookedByUserId: booker });
      // The same player books nothing at the other club; its diary is silent.
      const elsewhere = await loadDiaryDay(
        there.tenantId,
        formatInTimeZone(new Date(Date.now() + 3 * HOUR), 'Europe/Sofia', 'yyyy-MM-dd'),
        OPTS,
      );
      expect(JSON.stringify(elsewhere)).not.toContain('888123456');
    });
  });
});
