import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * The calendar of a weekly series (#364): which dates, and each date's
 * instants on the club's clock. Pure, so it is tested from both sides of
 * Greenwich (`npm run test:tz`) without a database.
 */

/** Longest series: a year of weeks. */
export const MAX_SERIES_WEEKS = 52;

/** The repeat runs backwards, or past a year. */
export class InvalidSeriesError extends Error {
  constructor(reason: string) {
    super(`That series cannot be made: ${reason}.`);
    this.name = 'InvalidSeriesError';
  }
}

/** Shift an ISO day by whole days, through UTC so month ends roll over. */
export function shiftIsoDay(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * The calendar dates of a weekly series, first first.
 *
 * `weeks: n` is n dates. `until` is every week up to and including that date.
 * More than a year of weeks is refused rather than truncated: a silently
 * shorter series is a customer who turns up to a court that is not theirs.
 * No repeat at all is the one date.
 */
export function weeklyDates(
  firstDate: string,
  repeat: { weeks?: number; until?: string } | undefined,
): string[] {
  if (!repeat) return [firstDate];
  if (repeat.weeks !== undefined) {
    if (repeat.weeks < 1 || repeat.weeks > MAX_SERIES_WEEKS) {
      throw new InvalidSeriesError(`it must be 1 to ${MAX_SERIES_WEEKS} weeks`);
    }
    return Array.from({ length: repeat.weeks }, (_, k) => shiftIsoDay(firstDate, 7 * k));
  }
  const until = repeat.until!;
  if (until < firstDate) throw new InvalidSeriesError('it ends before it starts');
  const dates: string[] = [];
  for (let d = firstDate; d <= until; d = shiftIsoDay(d, 7)) {
    dates.push(d);
    if (dates.length > MAX_SERIES_WEEKS) {
      throw new InvalidSeriesError(`it is longer than ${MAX_SERIES_WEEKS} weeks`);
    }
  }
  return dates;
}

export interface Span {
  date: string;
  startTs: Date;
  endTs: Date;
  /**
   * False when `startTime` does not exist on that day at the club — the hour
   * the clocks skip in spring. Such an occurrence is `unavailable`, never
   * silently moved to the hour after.
   */
  exists: boolean;
}

/**
 * One occurrence's instants: `startTime` on `date`, on the club's wall clock.
 *
 * ═══ RESOLVED PER DATE, SO DST CANNOT MOVE IT ═══
 *
 * The obvious implementation resolves the first occurrence and adds 7 × 24 h
 * for each next one. Across the last Sunday of October that drifts by an hour:
 * Sofia leaves UTC+3 for UTC+2, so a Tuesday 19:00 series would read 18:00 on
 * the diary from November on. `fromZonedTime` looks the offset up for each date
 * on its own, so every occurrence is 19:00 at the club — 16:00Z in summer time,
 * 17:00Z after. The duration is elapsed time, which is what a court is hired
 * for. Nothing here reads the host's zone.
 */
export function resolveSpan(
  date: string,
  startTime: string,
  durationMinutes: number,
  timezone: string,
): Span {
  const startTs = fromZonedTime(`${date}T${startTime}:00`, timezone);
  const endTs = new Date(startTs.getTime() + durationMinutes * 60_000);
  const exists =
    formatInTimeZone(startTs, timezone, "yyyy-MM-dd'T'HH:mm") === `${date}T${startTime}`;
  return { date, startTs, endTs, exists };
}
