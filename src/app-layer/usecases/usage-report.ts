import { Prisma, type PrismaClient } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { USAGE_TIME_ZONE, usageDay } from '@/lib/usage/events';
import { emptyCounts, type FunnelCounts, type Trend, trendOf } from '@/lib/usage/funnel';

export type { FunnelCounts, Trend };

/**
 * The pilot's numbers (#371, owner decision Q40): each club's online share of
 * its bookings, whether the club is still active, and the booking funnel.
 * docs/usage-counts.md says the same in prose.
 *
 * Two sources, deliberately:
 *
 *   - the ONLINE SHARE and ACTIVITY come from `booking` itself, never from the
 *     usage counters, so they are exact and go back to the first booking;
 *   - the FUNNEL comes from `usage_daily`, the anonymous daily counters, which
 *     start the day counting shipped.
 *
 * Every function takes the database handle it is given. The platform route
 * passes an audited BYPASSRLS one (asPlatformAdmin); a club's own page passes
 * its tenant binding, and RLS keeps it to that club's bookings.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** The zone every report bucket is told in: the pilot's, Sofia. */
export const REPORT_TIME_ZONE = USAGE_TIME_ZONE;

// ─── The definitions ────────────────────────────────────────────────

/**
 * The bookings the online share counts: ones that stand or were played.
 * PENDING (an unpaid hold), CANCELLED and NO_SHOW are left out.
 */
export const SHARE_STATUSES = ['CONFIRMED', 'COMPLETED'] as const;

/** A club with a booking made in this many days is active. */
export const ACTIVE_WINDOW_DAYS = 14;

export interface ChannelCounts {
  online: number;
  desk: number;
}

export interface ChannelBucket extends ChannelCounts {
  clubId: string;
  /** The bucket's first day in Sofia, `YYYY-MM-DD`: the 1st, or a Monday. */
  bucket: string;
}

/**
 * THE ONLINE SHARE, counted (Q40). The one place it is defined.
 *
 * A club's online share for a period is
 *
 *     online / (online + desk)
 *
 * over its bookings that are CONFIRMED or COMPLETED (`SHARE_STATUSES`), by
 * `Booking.channel` (P40): ONLINE is a player booking in the app or on the
 * web, DESK is the club entering one (#364), recurring series included.
 * Cancelled bookings are not counted on either side.
 *
 * A booking falls in the period its START is in, in Sofia — the month it is
 * played, not the month it was made — so a weekly series entered at the desk
 * in one sitting counts once per week it is played, not twenty times in the
 * month it was typed in. The current period therefore includes bookings
 * already made for its remaining days.
 *
 * `bucket` is `month` or `week` (ISO weeks, from Monday). `tenantId` narrows
 * to one club; without it every club the handle can see is counted.
 */
export async function countBookingsByChannel(
  db: PrismaClient,
  opts: { from: Date; to: Date; bucket: 'month' | 'week'; tenantId?: string },
): Promise<ChannelBucket[]> {
  const club = opts.tenantId ? Prisma.sql`AND b."tenantId" = ${opts.tenantId}` : Prisma.empty;
  return db.$queryRaw<ChannelBucket[]>`
    SELECT b."tenantId" AS "clubId",
           to_char(date_trunc(${opts.bucket}, b."startTs" AT TIME ZONE ${REPORT_TIME_ZONE}),
                   'YYYY-MM-DD') AS "bucket",
           (count(*) FILTER (WHERE b."channel" = 'ONLINE'))::int AS "online",
           (count(*) FILTER (WHERE b."channel" = 'DESK'))::int AS "desk"
      FROM booking b
     WHERE b."status" IN ('CONFIRMED', 'COMPLETED')
       AND b."startTs" >= ${opts.from}
       AND b."startTs" < ${opts.to}
       ${club}
     GROUP BY 1, 2`;
}

/** `online / (online + desk)`, or null when the club had no bookings at all. */
export function onlineShare(c: ChannelCounts): number | null {
  const total = c.online + c.desk;
  return total === 0 ? null : c.online / total;
}

/**
 * THE ACTIVE CLUB RULE (Q40). A club is active when it has at least one
 * booking (CONFIRMED or COMPLETED, either channel) MADE in the last
 * `ACTIVE_WINDOW_DAYS` days: somebody, player or desk, is still using playerz
 * there. By `createdAt`, not `startTs`, so a long desk series typed in once
 * does not keep a club that stopped using the product looking alive.
 */
export function isClubActive(lastBookingAt: Date | null, now: Date): boolean {
  if (!lastBookingAt) return false;
  return now.getTime() - lastBookingAt.getTime() <= ACTIVE_WINDOW_DAYS * DAY_MS;
}

/** The newest qualifying booking per club within the active window. */
async function recentBookingByClub(db: PrismaClient, now: Date): Promise<Map<string, Date>> {
  const rows = await db.booking.groupBy({
    by: ['tenantId'],
    where: {
      status: { in: [...SHARE_STATUSES] },
      createdAt: { gte: new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS) },
    },
    _max: { createdAt: true },
  });
  return new Map(
    rows.flatMap((r) => (r._max.createdAt ? [[r.tenantId, r._max.createdAt] as const] : [])),
  );
}

// ─── Calendar arithmetic, in Sofia ──────────────────────────────────

/** `YYYY-MM` moved by `delta` months. */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const index = y! * 12 + (m! - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of `now` moved by `offset` months, in Sofia. */
export function monthKey(now: Date, offset = 0): string {
  return shiftMonthKey(formatInTimeZone(now, REPORT_TIME_ZONE, 'yyyy-MM'), offset);
}

/** The instant a Sofia month (`YYYY-MM`) begins. */
function monthStart(key: string): Date {
  return fromZonedTime(`${key}-01T00:00:00`, REPORT_TIME_ZONE);
}

/** `YYYY-MM-DD` of the Monday of the Sofia week `now` is in, moved by `offset` weeks. */
function weekKey(now: Date, offset = 0): string {
  const today = usageDay(now);
  // ISO weekday of a calendar date, independent of the host's zone.
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = new Date(Date.parse(`${today}T12:00:00Z`) - dow * DAY_MS + offset * WEEK_MS);
  return monday.toISOString().slice(0, 10);
}

function dayStart(key: string): Date {
  return fromZonedTime(`${key}T00:00:00`, REPORT_TIME_ZONE);
}

// ─── A club's own card ──────────────────────────────────────────────

/** How many months the club's card shows, this one included. */
export const CLUB_TREND_MONTHS = 6;

export interface MonthShare extends ChannelCounts {
  /** `YYYY-MM`, in Sofia. */
  month: string;
  share: number | null;
}

export interface ClubOnlineShare {
  /** Oldest first; the last entry is the month asked for. */
  months: MonthShare[];
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * "Онлайн резервации" on a club's reports page: the online share of `month`
 * (`YYYY-MM` in Sofia; this month when absent or malformed) and of the five
 * months before it, so the card follows the month the statement shows. Pass
 * the club's TENANT binding.
 */
export async function loadClubOnlineShare(
  db: PrismaClient,
  tenantId: string,
  opts: { month?: string; now?: Date } = {},
): Promise<ClubOnlineShare> {
  const last =
    opts.month && MONTH_KEY.test(opts.month) ? opts.month : monthKey(opts.now ?? new Date());
  const keys = Array.from({ length: CLUB_TREND_MONTHS }, (_, i) =>
    shiftMonthKey(last, i - (CLUB_TREND_MONTHS - 1)),
  );
  const rows = await countBookingsByChannel(db, {
    from: monthStart(keys[0]!),
    to: monthStart(shiftMonthKey(last, 1)),
    bucket: 'month',
    tenantId,
  });
  const byMonth = new Map(rows.map((r) => [r.bucket.slice(0, 7), r]));
  return {
    months: keys.map((month) => {
      const r = byMonth.get(month);
      const counts = { online: r?.online ?? 0, desk: r?.desk ?? 0 };
      return { month, ...counts, share: onlineShare(counts) };
    }),
  };
}

// ─── The platform view ──────────────────────────────────────────────

/** The funnel ranges the platform view offers, in days ending today. */
export const FUNNEL_DAY_OPTIONS = [7, 30, 90] as const;
export type FunnelDays = (typeof FUNNEL_DAY_OPTIONS)[number];

/** How many weeks of online share each club row carries. */
export const CLUB_TREND_WEEKS = 8;

/** Plenty for the pilot's 3+ clubs; a ceiling, not a page. */
const MAX_CLUBS = 500;

export interface PlatformClubRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  startedAt: Date;
  weeksSinceStart: number;
  active: boolean;
  lastBookingAt: Date | null;
  thisMonth: ChannelCounts & { share: number | null };
  lastMonth: ChannelCounts & { share: number | null };
  /** This month's share against last month's, or null when either had no bookings. */
  trend: Trend | null;
  /** Oldest first; the last is this week. */
  weeks: Array<ChannelCounts & { week: string; share: number | null }>;
}

export interface VenueFunnel {
  venueId: string;
  venueName: string | null;
  clubId: string | null;
  clubName: string | null;
  counts: FunnelCounts;
}

export interface PlatformUsageReport {
  timeZone: string;
  month: string;
  previousMonth: string;
  clubs: PlatformClubRow[];
  funnel: {
    days: number;
    /** First and last day counted, `YYYY-MM-DD` in Sofia, inclusive. */
    from: string;
    to: string;
    site: FunnelCounts;
    venues: VenueFunnel[];
  };
}

/**
 * Everything `/platform/usage` shows. Pass the audited platform binding: it
 * reads every club's bookings and the usage counters, which deny app_user.
 */
export async function loadPlatformUsage(
  db: PrismaClient,
  opts: { now?: Date; days: FunnelDays },
): Promise<PlatformUsageReport> {
  const now = opts.now ?? new Date();
  const thisMonth = monthKey(now);
  const previousMonth = monthKey(now, -1);
  const firstWeek = weekKey(now, -(CLUB_TREND_WEEKS - 1));
  const weekKeys = Array.from({ length: CLUB_TREND_WEEKS }, (_, i) =>
    weekKey(now, i - (CLUB_TREND_WEEKS - 1)),
  );

  const toDay = usageDay(now);
  const fromDay = new Date(Date.parse(`${toDay}T00:00:00Z`) - (opts.days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const dayRange = { gte: new Date(`${fromDay}T00:00:00Z`), lte: new Date(`${toDay}T00:00:00Z`) };

  const clubs = await db.venueOrg.findMany({
    select: { id: true, slug: true, name: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_CLUBS,
  });
  const months = await countBookingsByChannel(db, {
    from: monthStart(previousMonth),
    to: monthStart(monthKey(now, 1)),
    bucket: 'month',
  });
  const weeks = await countBookingsByChannel(db, {
    from: dayStart(firstWeek),
    to: dayStart(weekKey(now, 1)),
    bucket: 'week',
  });
  const recent = await recentBookingByClub(db, now);

  // guardrail-allow: cross-tenant — the platform report spans every club by
  // design, under asPlatformAdmin's audited binding. usage_daily has no tenant.
  const siteRows = await db.usageDaily.groupBy({
    by: ['event'],
    where: { day: dayRange },
    _sum: { count: true },
  });
  // guardrail-allow: cross-tenant — the same report, per venue.
  const venueRows = await db.usageDaily.groupBy({
    by: ['venueId', 'clubId', 'event'],
    where: { day: dayRange, venueId: { not: '' } },
    _sum: { count: true },
  });
  const venueIds = [...new Set(venueRows.map((r) => r.venueId))];
  const venues = venueIds.length
    ? // guardrail-allow: cross-tenant — names for the venues counted above.
      // public-venue-filter: not a public read — an audited platform report,
      // which names a venue counted while it was public even if it is not now.
      await db.venue.findMany({
        where: { id: { in: venueIds } },
        select: { id: true, name: true },
        take: venueIds.length,
      })
    : [];

  // ── Clubs ──
  const monthOf = new Map(months.map((r) => [`${r.clubId}|${r.bucket.slice(0, 7)}`, r]));
  const weekOf = new Map(weeks.map((r) => [`${r.clubId}|${r.bucket}`, r]));
  const counts = (r: ChannelCounts | undefined) => {
    const c = { online: r?.online ?? 0, desk: r?.desk ?? 0 };
    return { ...c, share: onlineShare(c) };
  };

  const clubRows: PlatformClubRow[] = clubs.map((c) => {
    const cur = counts(monthOf.get(`${c.id}|${thisMonth}`));
    const prev = counts(monthOf.get(`${c.id}|${previousMonth}`));
    const last = recent.get(c.id) ?? null;
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      status: c.status,
      startedAt: c.createdAt,
      weeksSinceStart: Math.max(0, Math.floor((now.getTime() - c.createdAt.getTime()) / WEEK_MS)),
      active: isClubActive(last, now),
      lastBookingAt: last,
      thisMonth: cur,
      lastMonth: prev,
      trend: trendOf(cur.share, prev.share),
      weeks: weekKeys.map((week) => ({ week, ...counts(weekOf.get(`${c.id}|${week}`)) })),
    };
  });

  // ── Funnel ──
  const site = emptyCounts();
  for (const r of siteRows) site[r.event] = r._sum.count ?? 0;

  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const venueName = new Map(venues.map((v) => [v.id, v.name]));
  const perVenue = new Map<string, VenueFunnel>();
  for (const r of venueRows) {
    let v = perVenue.get(r.venueId);
    if (!v) {
      v = {
        venueId: r.venueId,
        venueName: venueName.get(r.venueId) ?? null,
        clubId: r.clubId,
        clubName: r.clubId ? (clubName.get(r.clubId) ?? null) : null,
        counts: emptyCounts(),
      };
      perVenue.set(r.venueId, v);
    }
    v.counts[r.event] += r._sum.count ?? 0;
  }

  return {
    timeZone: REPORT_TIME_ZONE,
    month: thisMonth,
    previousMonth,
    clubs: clubRows,
    funnel: {
      days: opts.days,
      from: fromDay,
      to: toDay,
      site,
      // Busiest first: the venues with the most visits are the ones to read.
      venues: [...perVenue.values()].sort(
        (a, b) => b.counts.VENUE_VIEW - a.counts.VENUE_VIEW || a.venueId.localeCompare(b.venueId),
      ),
    },
  };
}
