import { formatInTimeZone } from 'date-fns-tz';

/**
 * The venue page's calendar and its URL state (#355). No directive: the page
 * (a server component) calls these, and the client component reuses the URL
 * builder.
 *
 * ═══ DAYS ARE THE CLUB'S, NEVER THE DEVICE'S ═══
 *
 * "Today" is today in the venue's zone (Europe/Sofia for every pilot club),
 * worked out on the server. A phone set to another zone — a visitor from
 * London, or a device whose clock says it is still yesterday — would otherwise
 * offer a day picker one day off around midnight. The keys are plain calendar
 * dates (`YYYY-MM-DD`); the availability endpoint resolves each to that day's
 * local midnights itself (`?date=`), DST included.
 */

/** Today plus 13: the availability endpoint's 14-day ceiling. */
export const BOOKING_DAYS = 14;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` for today at the club, then the next 13 calendar days. */
export function bookingDays(now: Date, timezone: string): string[] {
  const today = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = 0; i < BOOKING_DAYS; i++) {
    // Calendar arithmetic in UTC, where every day is 24 hours: no zone, no DST.
    out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  }
  return out;
}

/** A `publicSlug` as P41 writes them; anything else is a 404 before a query. */
export function isPublicSlug(raw: string): boolean {
  return raw.length > 0 && raw.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw);
}

/** What the URL asks the page to show: a day, and maybe a slot (`court` + `start` + `min`). */
export interface InitialPick {
  day: string;
  court: string | null;
  /** RFC 3339 UTC without fractional seconds, as the availability DTO writes it. */
  start: string | null;
  minutes: number | null;
  /** Open the confirmation sheet at once: the sign-in round trip came back. */
  confirm: boolean;
}

function one(v: string | string[] | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The URL's pick, validated. Every value is a HINT: the client applies it only
 * if that court has that start free for that length in the day's slots, so a
 * stale or hand-edited link shows the day and selects nothing. Nothing here is
 * ever used as a destination.
 */
export function parseInitialPick(
  sp: Record<string, string | string[] | undefined>,
  days: readonly string[],
): InitialPick {
  const dayRaw = one(sp.day);
  const day = dayRaw && DATE_KEY.test(dayRaw) && days.includes(dayRaw) ? dayRaw : days[0]!;

  const courtRaw = one(sp.court);
  const court = courtRaw && /^[A-Za-z0-9_-]{1,64}$/.test(courtRaw) ? courtRaw : null;

  const startRaw = one(sp.start);
  const startMs = startRaw ? Date.parse(startRaw) : NaN;
  const start = Number.isNaN(startMs)
    ? null
    : new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const minRaw = Number(one(sp.min));
  const minutes = Number.isInteger(minRaw) && minRaw > 0 && minRaw <= 24 * 60 ? minRaw : null;

  return {
    day,
    court: court && start ? court : null,
    start: court && start ? start : null,
    minutes: court && start ? minutes : null,
    confirm: one(sp.confirm) === '1' && court !== null && start !== null,
  };
}

/**
 * This page's own URL for a day and, optionally, a slot. Built from the
 * venue's public slug and values the page itself holds — never from anything
 * the visitor typed — so it is safe to hand to /login as `next`. The login page
 * checks it again regardless (`postSignInPath`: same origin, a path, not /api).
 */
export function venuePagePath(
  publicSlug: string,
  pick: {
    day: string;
    court?: string | null;
    start?: string | null;
    minutes?: number | null;
    confirm?: boolean;
  },
): string {
  const q = new URLSearchParams({ day: pick.day });
  if (pick.court && pick.start) {
    q.set('court', pick.court);
    q.set('start', pick.start);
    if (pick.minutes) q.set('min', String(pick.minutes));
    if (pick.confirm) q.set('confirm', '1');
  }
  return `/venues/${encodeURIComponent(publicSlug)}?${q.toString()}`;
}
