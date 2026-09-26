import { notFound } from 'next/navigation';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { getLocale, getTranslations } from 'next-intl/server';

import { listCourts } from '@/app-layer/repositories/court';
import { dayWindow, listDayBookings } from '@/app-layer/repositories/diary';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { DayGrid, type DayBooking, type GridCourt } from './DayGrid';

export async function generateMetadata() {
  const t = await getTranslations('admin.calendar');
  return { title: t('metaTitle') };
}

/** `2026-01-15`, and nothing else — this reaches a date constructor. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Shift an ISO day by whole days, through UTC so month ends roll over. */
function shiftDay(isoDay: string, delta: number): string {
  const [y, m, d] = isoDay.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

/**
 * The club's diary for one day.
 *
 * ═══ EVERY TIME IS RESOLVED HERE, IN THE CLUB'S ZONE ═══
 *
 * The grid receives strings — "18:00", never a Date. If it formatted times
 * itself it would use the VIEWER's timezone, so a manager checking the diary
 * from abroad would see every booking shifted against hour labels that were
 * not, and the grid would silently disagree with itself.
 *
 * `VenueOrg.timezone` is the club's, which is the right level: the diary is the
 * club's day, and a club's courts may sit at more than one venue.
 *
 * ═══ THE DEFAULT DAY IS THE CLUB'S TODAY ═══
 *
 * Not the server's and not the viewer's. At 23:30 in Sofia it is already
 * tomorrow in UTC, so a server-side `new Date().toISOString().slice(0,10)`
 * would open the diary on the wrong day every evening.
 */
export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [t, locale] = await Promise.all([getTranslations('admin.calendar'), getLocale()]);

  const { timezone, courts, bookings, names } = await runInTenantContext(
    ctx.tenantId,
    async (db) => {
      const club = await db.venueOrg.findFirstOrThrow({
        where: { id: ctx.tenantId },
        select: { timezone: true },
      });

      const courtRows = await listCourts(db, ctx.tenantId);

      const todayAtClub = formatInTimeZone(new Date(), club.timezone, 'yyyy-MM-dd');
      const requested = sp.day && ISO_DAY.test(sp.day) ? sp.day : todayAtClub;

      const rows = await listDayBookings(db, ctx.tenantId, {
        isoDay: requested,
        timezone: club.timezone,
      });

      // Names for the members who booked. Guests carry their own name on the
      // booking, so only the user-backed ones need a lookup.
      const userIds = [
        ...new Set(rows.map((r) => r.bookedByUserId).filter((v): v is string => !!v)),
      ];
      const users = userIds.length
        ? await db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
            take: 1000,
          })
        : [];

      return {
        timezone: club.timezone,
        courts: courtRows,
        bookings: rows,
        names: new Map(users.map((u) => [u.id, u.name ?? u.email])),
        requested,
      };
    },
  ).then((r) => r);

  const todayAtClub = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
  const isoDay = sp.day && ISO_DAY.test(sp.day) ? sp.day : todayAtClub;
  const { from } = dayWindow(isoDay, timezone);

  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const hhmm = (d: Date) => formatInTimeZone(d, timezone, 'HH:mm');

  /** Minutes from the start of the club's local day. */
  const localMinutes = (d: Date) => Math.round((d.getTime() - from.getTime()) / 60_000);

  const entries: DayBooking[] = bookings.map((b) => {
    const startMin = localMinutes(b.startTs);
    return {
      id: b.id,
      resourceId: b.resourceId,
      startLabel: hhmm(b.startTs),
      endLabel: hhmm(b.endTs),
      startOffsetMinutes: startMin,
      durationMinutes: Math.max(Math.round((b.endTs.getTime() - b.startTs.getTime()) / 60_000), 15),
      status: b.status,
      who: b.bookedByUserId
        ? (names.get(b.bookedByUserId) ?? t('unknownPlayer'))
        : (b.guestName ?? t('guest')),
      priceLabel: money.format(b.totalCents / 100),
      expiresLabel: b.expiresAt ? hhmm(b.expiresAt) : null,
    };
  });

  // The grid spans the bookings, widened to a sensible working day. Drawing a
  // fixed 00:00–23:00 would be 24 mostly-empty rows to scroll past; drawing
  // only the booked hours would make an empty day a blank page.
  const bookedHours = entries.flatMap((e) => [
    Math.floor(e.startOffsetMinutes / 60),
    Math.ceil((e.startOffsetMinutes + e.durationMinutes) / 60),
  ]);
  const firstHour = Math.max(0, Math.min(8, ...bookedHours));
  const lastHour = Math.min(23, Math.max(22, ...bookedHours));

  // Offsets are relative to the grid's first hour, not to local midnight.
  const shifted = entries.map((e) => ({
    ...e,
    startOffsetMinutes: e.startOffsetMinutes - firstHour * 60,
  }));

  const dayLabel = formatInTimeZone(toZonedTime(from, timezone), timezone, 'EEEE d MMMM yyyy');

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <DayGrid
        slug={slug}
        isoDay={isoDay}
        prevDay={shiftDay(isoDay, -1)}
        nextDay={shiftDay(isoDay, 1)}
        isToday={isoDay === todayAtClub}
        dayLabel={dayLabel}
        courts={courts.map((c): GridCourt => ({ id: c.id, name: c.name }))}
        bookings={shifted}
        firstHour={firstHour}
        lastHour={lastHour}
      />
    </section>
  );
}
