import { formatInTimeZone } from 'date-fns-tz';

/** How far ahead a day picker goes: today at the venue and the next 13 days. */
export const BOOKING_DAYS = 14;

/** `YYYY-MM-DD` for today at the venue, then the next 13 calendar days. */
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
