/**
 * The assistant's slot logic, pure (owner 2026-11-14, #704): which hours are
 * free to book, and which of them suit a group of players. No database here;
 * the use cases (`assistant-find-places`, `assistant-best-time`) read the
 * rows and hand them in, which is what lets the ranking be unit-tested.
 *
 * The hours are the ones the app offers (src/lib/booking/hour-grid.ts and
 * offers.ts): starts on the hour on the club's clock, not yet begun, free for
 * the whole length, at the price the club's availability gives that length.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** A free start on one court, for one length, as `loadVenueAvailability` prices it. */
export interface FreeStart {
  resourceId: string;
  startTs: Date;
  endTs: Date;
  minutes: number;
  priceCents: number;
}

export interface ResourceSlots {
  resource: { id: string; sport: string; minBookingMinutes: number };
  slots: Array<{
    startTs: Date;
    available: boolean;
    durations?: Array<{ minutes: number; endTs: Date; priceCents: number }>;
  }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isLocalTime(s: string): boolean {
  return TIME_RE.test(s);
}

/** `HH:MM` → minutes from midnight. */
export function minutesOf(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new RangeError(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whole local days `dateFrom`..`dateTo` (inclusive) at the club, as instants. */
export function localDayRange(
  dateFrom: string,
  dateTo: string,
  timeZone: string,
): { from: Date; to: Date } {
  const from = fromZonedTime(`${dateFrom}T00:00:00`, timeZone);
  const next = new Date(`${dateTo}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const to = fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, timeZone);
  return { from, to };
}

/** Number of calendar days `dateFrom`..`dateTo`, inclusive. */
export function daySpan(dateFrom: string, dateTo: string): number {
  return (
    Math.round(
      (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

export interface LocalClock {
  /** `YYYY-MM-DD` at the club. */
  date: string;
  /** `HH:MM` at the club. */
  time: string;
  /** Minutes from local midnight. */
  minutes: number;
  /** `Mon`..`Sun`, for the model to name the day. */
  weekday: string;
}

export function clockOf(d: Date, timeZone: string): LocalClock {
  const time = formatInTimeZone(d, timeZone, 'HH:mm');
  return {
    date: formatInTimeZone(d, timeZone, 'yyyy-MM-dd'),
    time,
    minutes: minutesOf(time),
    weekday: formatInTimeZone(d, timeZone, 'EEE'),
  };
}

/**
 * The length to look for on one court: the one asked for when the court
 * takes it, otherwise an hour when it takes that, otherwise its minimum.
 */
export function lengthFor(
  resource: ResourceSlots['resource'],
  wanted: number | undefined,
  offered: number[],
): number | null {
  if (wanted && offered.includes(wanted)) return wanted;
  if (wanted) return null;
  if (offered.includes(60)) return 60;
  return offered.includes(resource.minBookingMinutes)
    ? resource.minBookingMinutes
    : (offered[0] ?? null);
}

/**
 * Free starts on the hour, not yet begun, inside an optional local time window
 * (`timeFrom` ≤ start, end ≤ `timeTo`), for `minutes` (or the court's default).
 */
export function freeHourlyStarts(
  r: ResourceSlots,
  opts: { now: Date; timeZone: string; minutes?: number; timeFrom?: string; timeTo?: string },
): FreeStart[] {
  const lo = opts.timeFrom ? minutesOf(opts.timeFrom) : 0;
  const hi = opts.timeTo ? minutesOf(opts.timeTo) : 24 * 60;
  const out: FreeStart[] = [];
  for (const s of r.slots) {
    if (!s.available || s.startTs.getTime() <= opts.now.getTime()) continue;
    const clock = clockOf(s.startTs, opts.timeZone);
    if (clock.minutes % 60 !== 0) continue;
    const offered = (s.durations ?? []).map((d) => d.minutes);
    const length = lengthFor(r.resource, opts.minutes, offered);
    if (length === null) continue;
    const d = s.durations?.find((x) => x.minutes === length);
    if (!d) continue;
    if (clock.minutes < lo || clock.minutes + length > hi) continue;
    out.push({
      resourceId: r.resource.id,
      startTs: s.startTs,
      endTs: d.endTs,
      minutes: length,
      priceCents: d.priceCents,
    });
  }
  return out;
}

/** The cheapest court at each start time: one option per hour, not one per court. */
export function cheapestPerStart(starts: FreeStart[]): FreeStart[] {
  const best = new Map<number, FreeStart>();
  for (const s of starts) {
    const k = s.startTs.getTime();
    const cur = best.get(k);
    if (!cur || s.priceCents < cur.priceCents) best.set(k, s);
  }
  return [...best.values()].sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
}

// ─── Who can make a time ──────────────────────────────────────────────────

export interface Interval {
  start: Date;
  end: Date;
}

/**
 * What is known about one player's time. `calendar: null` means their Google
 * Calendar is not known (not connected, revoked, unavailable): their playerz
 * bookings still count as busy, but a time is never assumed free for them.
 */
export interface PlayerTime {
  userId: string;
  name: string;
  /** Busy intervals from their Google Calendar, or null when unknown. */
  calendar: Interval[] | null;
  /** Why the calendar is unknown, when it is. */
  unknownReason?: string;
  /** Their other playerz bookings in the window: always known. */
  bookings: Interval[];
}

export type Availability = 'free' | 'busy' | 'unknown';

function overlaps(a: Interval, start: Date, end: Date): boolean {
  return a.start.getTime() < end.getTime() && start.getTime() < a.end.getTime();
}

export function availabilityAt(p: PlayerTime, start: Date, end: Date): Availability {
  if (p.bookings.some((b) => overlaps(b, start, end))) return 'busy';
  if (p.calendar === null) return 'unknown';
  return p.calendar.some((b) => overlaps(b, start, end)) ? 'busy' : 'free';
}

export interface RankedOption {
  start: FreeStart;
  free: PlayerTime[];
  unknown: PlayerTime[];
}

/**
 * The best times for a group: nobody known to be busy; everyone known-free
 * first, then the fewest unknowns, then the soonest. At most `limit`, on
 * different days where the candidates allow it, so three options are not
 * three neighbouring hours of one evening.
 */
export function rankTimes(
  candidates: FreeStart[],
  players: PlayerTime[],
  opts: { timeZone: string; limit?: number },
): RankedOption[] {
  const limit = opts.limit ?? 3;
  const scored: RankedOption[] = [];
  for (const c of candidates) {
    const free: PlayerTime[] = [];
    const unknown: PlayerTime[] = [];
    let busy = false;
    for (const p of players) {
      const a = availabilityAt(p, c.startTs, c.endTs);
      if (a === 'busy') {
        busy = true;
        break;
      }
      (a === 'free' ? free : unknown).push(p);
    }
    if (!busy) scored.push({ start: c, free, unknown });
  }
  scored.sort(
    (a, b) =>
      a.unknown.length - b.unknown.length ||
      a.start.startTs.getTime() - b.start.startTs.getTime() ||
      a.start.priceCents - b.start.priceCents,
  );
  const picked: RankedOption[] = [];
  const days = new Set<string>();
  const dayOf = (o: RankedOption) => clockOf(o.start.startTs, opts.timeZone).date;
  for (const o of scored) {
    if (picked.length >= limit) break;
    // Only a better-or-equal tier may take a new day ahead of the next best.
    if (picked.length > 0 && o.unknown.length > (picked[0]?.unknown.length ?? 0)) break;
    if (days.has(dayOf(o))) continue;
    days.add(dayOf(o));
    picked.push(o);
  }
  for (const o of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(o)) picked.push(o);
  }
  return picked.sort(
    (a, b) =>
      a.unknown.length - b.unknown.length || a.start.startTs.getTime() - b.start.startTs.getTime(),
  );
}
