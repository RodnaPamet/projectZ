import { notFound } from 'next/navigation';
import { formatInTimeZone } from 'date-fns-tz';
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

  const { timezone, courts, bookings, names, isoDay, todayAtClub } = await runInTenantContext(
    ctx.tenantId,
    async (db) => {
      const club = await db.venueOrg.findFirstOrThrow({
        where: { id: ctx.tenantId },
        select: { timezone: true },
      });

      // ═══ ARCHIVED COURTS STILL HAVE BOOKINGS ═══
      //
      // `listCourts` hides CLOSED by default, which is right for the courts
      // screen and wrong here: archiving a court does NOT cancel the bookings
      // already taken on it — the courts screen says so explicitly. Excluding
      // them gave those bookings no column to render in, so they vanished from
      // the diary while the club was still expected to honour them. The "empty
      // day" notice was suppressed too, because it is gated on having courts.
      const courtRows = await listCourts(db, ctx.tenantId, { includeArchived: true });

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
        isoDay: requested,
        todayAtClub,
      };
    },
  ).then((r) => r);

  // ═══ THE DAY IS THE ONE THE QUERY USED ═══
  //
  // These were recomputed here from a SECOND `new Date()`. A request with no
  // `?day=` that straddles the club's local midnight between the query and
  // this line fetched one day's bookings and rendered them against the next
  // day's window, header and links — every block roughly 24 hours out of
  // place. Rare, and silent, and exactly the kind of thing that happens at
  // 23:59 to the one person still at the front desk.
  const { from } = dayWindow(isoDay, timezone);

  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const hhmm = (d: Date) => formatInTimeZone(d, timezone, 'HH:mm');

  /**
   * Where an instant sits on the club's WALL CLOCK, in minutes from midnight.
   *
   * ═══ NOT ELAPSED TIME FROM THE WINDOW START ═══
   *
   * This was `(d - from) / 60000`, which is elapsed ABSOLUTE time. On an
   * ordinary day the two agree. On a DST day they diverge by an hour from the
   * transition onward, so a booking that `hhmm` labels "15:00" was drawn
   * against the 16:00 ruler — the grid disagreeing with itself, which the
   * docblock above claims cannot happen.
   *
   * Reading the same wall clock the label reads makes them agree by
   * construction, rather than by arithmetic that is right for 363 days a year.
   *
   * The day comparison handles the overlap case the repository deliberately
   * includes: a 23:00–00:30 booking appears on BOTH days' diaries, so on the
   * later day its start is yesterday's wall clock and belongs at a negative
   * offset rather than at 1380 minutes.
   */
  const wallMinutes = (d: Date) => {
    const [hh, mm] = formatInTimeZone(d, timezone, 'HH:mm').split(':');
    const minutes = Number(hh) * 60 + Number(mm);
    const onDay = formatInTimeZone(d, timezone, 'yyyy-MM-dd');
    if (onDay < isoDay) return minutes - 1440;
    if (onDay > isoDay) return minutes + 1440;
    return minutes;
  };

  const entries: DayBooking[] = bookings.map((b) => {
    const startMin = wallMinutes(b.startTs);
    const endMin = wallMinutes(b.endTs);
    return {
      id: b.id,
      resourceId: b.resourceId,
      startLabel: hhmm(b.startTs),
      endLabel: hhmm(b.endTs),
      startOffsetMinutes: startMin,
      // Wall-clock height, to match the wall-clock rows it is drawn against.
      // Absolute duration would make a booking spanning the changeover an hour
      // taller or shorter than the hours it actually covers on the ruler.
      durationMinutes: Math.max(endMin - startMin, 15),
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
  // Clamped to a real day, but widened to whatever the bookings need. An
  // overlap booking from the previous evening has a NEGATIVE offset, so
  // without the lower clamp the grid would start at a negative hour; without
  // widening, that block would render above the first row and be invisible.
  const firstHour = Math.max(0, Math.min(8, ...bookedHours));
  const lastHour = Math.min(24, Math.max(22, ...bookedHours));

  // Offsets are relative to the grid's first hour, not to local midnight.
  const shifted = entries.map((e) => ({
    ...e,
    startOffsetMinutes: e.startOffsetMinutes - firstHour * 60,
  }));

  // `formatInTimeZone` converts from an instant, so handing it a `toZonedTime`
  // result converted TWICE. On a server east of the club that landed a day
  // early: "Wednesday 14 January" above Thursday's grid, with prev/next links
  // stepping from the correct day.
  const dayLabel = formatInTimeZone(from, timezone, 'EEEE d MMMM yyyy');

  // A single-site club does not need its one venue repeated on every column.
  const multiSite = new Set(courts.map((c) => c.venueId)).size > 1;

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
        courts={courts.map((c): GridCourt => ({
          id: c.id,
          name: c.name,
          // Only when the club has more than one site. Two courts named
          // "Court 1" at different venues are otherwise adjacent, identical
          // columns, and a front-desk operator cannot tell which is theirs.
          venueName: multiSite ? c.venue.name : null,
        }))}
        bookings={shifted}
        firstHour={firstHour}
        lastHour={lastHour}
      />
    </section>
  );
}
