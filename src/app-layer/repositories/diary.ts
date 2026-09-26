import type { BookingStatus, PrismaClient } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';

/**
 * One day's bookings across every court — the front-desk diary.
 *
 * ═══ "THURSDAY" IS A WALL-CLOCK FACT, NOT AN INSTANT ═══
 *
 * A booking is `timestamptz`; a day is not. Sofia is UTC+2 in winter and UTC+3
 * in summer, so the absolute window that means "Thursday at this club" depends
 * on the date — and on the two changeover days a day is 23 or 25 hours long.
 *
 * The naive version builds the window from `new Date()` in the SERVER's zone.
 * That is right on a laptop in Sofia, right in CI (UTC) for half the year, and
 * then silently shows the wrong day's bookings from the end of March. It is
 * also wrong all year for a manager checking the diary from abroad — their
 * Thursday is not the club's.
 *
 * So the window is built with `fromZonedTime`, which does the offset lookup for
 * that specific date in that specific zone. `availability.ts` documents the
 * same trap for opening hours; this is the read side of it.
 *
 * ═══ WHY PENDING IS INCLUDED ═══
 *
 * A PENDING booking HOLDS the slot — `expiresAt` is what releases it. A diary
 * that showed only CONFIRMED would tell a staff member a court is free while
 * somebody is mid-checkout on it, and they would double-book by hand.
 *
 * CANCELLED and NO_SHOW are excluded: the slot is genuinely free again.
 */

/** Status values that occupy a slot. Mirrors the booking path's own set. */
export const DIARY_STATUSES: readonly BookingStatus[] = ['PENDING', 'CONFIRMED', 'COMPLETED'];

export const DIARY_LIMIT = 1000;

export interface DiaryEntry {
  id: string;
  resourceId: string;
  startTs: Date;
  endTs: Date;
  status: BookingStatus;
  totalCents: number;
  /** Null for a guest booking — the guest name is the identity then. */
  bookedByUserId: string | null;
  guestName: string | null;
  expiresAt: Date | null;
}

/**
 * The absolute window covering `isoDay` at a venue in `timezone`.
 *
 * Exported so a test can assert the DST days directly, without a database.
 */
export function dayWindow(isoDay: string, timezone: string): { from: Date; to: Date } {
  const from = fromZonedTime(`${isoDay}T00:00:00`, timezone);
  // Built from the NEXT calendar day at midnight, not `from + 24h`. On a
  // spring-forward day the local day is 23 hours long and adding 24 would
  // reach into the next day; on autumn fall-back it is 25 and adding 24 would
  // miss the last hour of bookings.
  const [y, m, d] = isoDay.split('-').map((n) => Number.parseInt(n, 10));
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const nextIso = next.toISOString().slice(0, 10);
  const to = fromZonedTime(`${nextIso}T00:00:00`, timezone);

  return { from, to };
}

export async function listDayBookings(
  db: PrismaClient,
  tenantId: string,
  opts: { isoDay: string; timezone: string },
): Promise<DiaryEntry[]> {
  const { from, to } = dayWindow(opts.isoDay, opts.timezone);

  return db.booking.findMany({
    where: {
      tenantId,
      status: { in: [...DIARY_STATUSES] },
      // Overlap, not containment: a booking running 23:00–00:30 belongs on
      // both days' diaries, and a staff member looking at either needs to see
      // the court is occupied.
      startTs: { lt: to },
      endTs: { gt: from },
    },
    select: {
      id: true,
      resourceId: true,
      startTs: true,
      endTs: true,
      status: true,
      totalCents: true,
      bookedByUserId: true,
      guestName: true,
      expiresAt: true,
    },
    orderBy: [{ startTs: 'asc' }, { id: 'asc' }],
    take: DIARY_LIMIT,
  });
}
